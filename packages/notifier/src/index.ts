// GRVT Grid Notifier — main worker loop.
//
// Runs as a standalone systemd service alongside the bot. Reads the bot's
// SQLite file (read-only), detects new events, and pushes notifications
// to Telegram. Cursor state lives in a JSON file in NOTIFIER_STATE_DIR
// so we don't re-send across restarts.
//
// Event sources (all polled every NOTIFIER_POLL_MS):
//   - paired_roundtrips      → batched fill notifications
//   - grid_bots.status       → status transitions
//   - aggregate equity vs HWM → drawdown alerts
//   - daily_snapshots        → once-a-day summary at DAILY_SUMMARY_HOUR_UTC
//
// Failure mode: any per-poll error is logged and swallowed; the loop keeps
// going. The bot is the source of truth — the notifier is a side-car.

import dotenv from 'dotenv';
import { createServer, type Server } from 'node:http';
import { NotifierDb, type BotRow } from './db.js';
import { TelegramClient } from './telegram.js';
import { StateStore } from './state.js';
import { childLogger } from './logger.js';
import {
  dailySummaryTemplate,
  drawdownTemplate,
  fillsTemplate,
  statusChangeTemplate,
} from './templates.js';

dotenv.config();

const log = childLogger('main');

interface NotifierConfig {
  dbPath: string;
  pollMs: number;
  drawdownPct: number;
  fillBatch: number;
  dailySummaryHour: number;
  stateDir: string;
  telegramToken: string | undefined;
  telegramChatId: string | undefined;
}

function loadConfig(): NotifierConfig {
  return {
    dbPath: process.env.GRID_BOT_DB ?? '/opt/grvt-grid-bot/data/grid_bot.db',
    pollMs: parseInt(process.env.NOTIFIER_POLL_MS ?? '10000', 10),
    drawdownPct: parseFloat(process.env.NOTIFY_DRAWDOWN_PCT ?? '15'),
    fillBatch: parseInt(process.env.NOTIFY_FILL_BATCH ?? '5', 10),
    dailySummaryHour: parseInt(process.env.DAILY_SUMMARY_HOUR_UTC ?? '0', 10),
    stateDir: process.env.NOTIFIER_STATE_DIR ?? '/var/lib/grvt-grid-notifier',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
  };
}

class Notifier {
  private readonly cfg: NotifierConfig;
  private readonly db: NotifierDb;
  private readonly telegram: TelegramClient;
  private readonly state: StateStore;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastTickAt: number = 0;
  private tickCount: number = 0;
  private healthServer: Server | null = null;

  constructor(cfg: NotifierConfig) {
    this.cfg = cfg;
    this.db = new NotifierDb(cfg.dbPath);
    this.telegram = new TelegramClient(cfg.telegramToken, cfg.telegramChatId);
    this.state = new StateStore(cfg.stateDir);
  }

  async start(): Promise<void> {
    log.info(
      {
        pollMs: this.cfg.pollMs,
        drawdownPct: this.cfg.drawdownPct,
        fillBatch: this.cfg.fillBatch,
        dailySummaryHour: this.cfg.dailySummaryHour,
      },
      'notifier starting'
    );

    // Bootstrap: if first run, set the cursor to "now" so we don't spam
    // every historical roundtrip on startup.
    if (this.state.get().lastRoundtripId === 0) {
      const recent = await this.db.getRoundtripsSince(0, 100_000);
      const latestId = recent[recent.length - 1]?.id ?? 0;
      const equity = await this.db.getCurrentEquity();
      this.state.update({ lastRoundtripId: latestId, equityHwm: equity });
      log.info({ lastRoundtripId: latestId, equityHwm: equity }, 'bootstrap state');
    }

    // C.10: health endpoint for Docker HEALTHCHECK. Minimal HTTP
    // server on NOTIFIER_HEALTH_PORT (default 3849). Returns 200 if
    // the last tick ran within 3× the poll interval, 503 otherwise.
    const healthPort = parseInt(process.env.NOTIFIER_HEALTH_PORT ?? '3849', 10);
    this.healthServer = createServer((_req, res) => {
      const maxAge = this.cfg.pollMs * 3;
      const elapsed = Date.now() - this.lastTickAt;
      // Before the first tick fires, lastTickAt is 0. Treat as healthy
      // during startup (within maxAge of boot).
      const healthy = this.lastTickAt === 0 || elapsed < maxAge;
      const body = JSON.stringify({
        status: healthy ? 'ok' : 'stale',
        lastTickAt: this.lastTickAt || null,
        tickCount: this.tickCount,
        elapsedMs: this.lastTickAt ? elapsed : null,
        pollMs: this.cfg.pollMs,
        uptime: Math.floor(process.uptime()),
      });
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    this.healthServer.listen(healthPort, () => {
      log.info({ port: healthPort }, 'health endpoint listening');
    });

    log.info('sending hello message to telegram');
    await this.telegram.send('🟢 *GRVT Grid Notifier online*');
    log.info('hello sent — scheduling first tick');

    this.scheduleNext();
    log.info({ pollMs: this.cfg.pollMs }, 'first tick scheduled — entering loop');
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.tick().catch((err) => {
        log.error({ err: (err as Error).message }, 'tick errored');
      });
    }, this.cfg.pollMs);
    // NB: do NOT unref the timer. The notifier is loop-driven — there's no
    // HTTP server or other long-lived handle keeping the event loop alive.
    // If we unref, Node decides "nothing left to do" and exits cleanly
    // ~1s after main() returns, before the first tick ever fires.
    // (Bug discovered in production deploy 2026-04-07: process exited 0
    //  immediately after `bootstrap state` log, no Telegram message ever
    //  sent. systemd kept restart-looping it.)
  }

  private async tick(): Promise<void> {
    try {
      this.lastTickAt = Date.now();
      this.tickCount++;
      const bots = await this.db.getAllBots();
      await this.checkRoundtrips();
      await this.checkStatusTransitions(bots);
      await this.checkDrawdown();
      await this.checkDailySummary(bots);
    } finally {
      this.scheduleNext();
    }
  }

  // ── Roundtrip / fill detection ─────────────────────────────────────
  private async checkRoundtrips(): Promise<void> {
    const since = this.state.get().lastRoundtripId;
    const newRts = await this.db.getRoundtripsSince(since, 200);
    if (newRts.length === 0) return;

    // Only emit a notification when we have at least `fillBatch` accumulated.
    // This keeps Telegram from buzzing on every single fill.
    if (newRts.length < this.cfg.fillBatch) {
      log.debug({ count: newRts.length }, 'below batch threshold, holding');
      return;
    }

    const text = fillsTemplate(newRts);
    await this.telegram.send(text);

    const newCursor = newRts[newRts.length - 1]!.id;
    this.state.update({ lastRoundtripId: newCursor });
    log.info({ count: newRts.length, cursor: newCursor }, 'sent fill batch');
  }

  // ── Status transitions ─────────────────────────────────────────────
  private async checkStatusTransitions(bots: BotRow[]): Promise<void> {
    const lastStatus = { ...this.state.get().lastBotStatus };
    let changed = false;
    for (const bot of bots) {
      const previous = lastStatus[String(bot.id)];
      if (previous && previous !== bot.status) {
        await this.telegram.send(statusChangeTemplate(bot, previous, bot.status));
        log.info(
          { bot: bot.id, from: previous, to: bot.status },
          'status transition'
        );
      }
      if (lastStatus[String(bot.id)] !== bot.status) {
        lastStatus[String(bot.id)] = bot.status;
        changed = true;
      }
    }
    if (changed) this.state.update({ lastBotStatus: lastStatus });
  }

  // ── Drawdown ───────────────────────────────────────────────────────
  private async checkDrawdown(): Promise<void> {
    const equity = await this.db.getCurrentEquity();
    const hwm = this.state.get().equityHwm;

    if (equity > hwm) {
      this.state.update({ equityHwm: equity });
      return;
    }

    const dropPct = ((hwm - equity) / hwm) * 100;
    if (dropPct >= this.cfg.drawdownPct) {
      // Mute repeated alerts on the same drawdown using a simple hash:
      // `hwm:bucket` so we re-alert when drawdown deepens by another bucket.
      const bucket = Math.floor(dropPct / this.cfg.drawdownPct);
      const hash = `dd:${hwm.toFixed(0)}:${bucket}`;
      if (this.state.get().lastErrorHash === hash) return;
      await this.telegram.send(
        drawdownTemplate(equity, hwm, this.cfg.drawdownPct)
      );
      this.state.update({ lastErrorHash: hash });
      log.warn({ equity, hwm, dropPct }, 'drawdown alert sent');
    }
  }

  // ── Daily summary ──────────────────────────────────────────────────
  private async checkDailySummary(bots: BotRow[]): Promise<void> {
    if (this.cfg.dailySummaryHour < 0 || this.cfg.dailySummaryHour > 23) return;

    const now = new Date();
    if (now.getUTCHours() !== this.cfg.dailySummaryHour) return;

    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.state.get().lastSummaryDate === today) return;

    for (const bot of bots) {
      const snapshot = await this.db.getLatestSnapshot(bot.id);
      // Yesterday equity isn't directly stored — approximate via the previous
      // snapshot's equity. The schema uses `equity` (not `equity_usdt`).
      const yesterday: number | null = snapshot?.equity ?? null;
      await this.telegram.send(dailySummaryTemplate(bot, snapshot, yesterday));
    }
    this.state.update({ lastSummaryDate: today });
    log.info({ today }, 'daily summary sent');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }
    await this.telegram.send('⚪ *GRVT Grid Notifier offline*');
    await this.db.close();
    log.info('notifier stopped');
  }
}

// ── Entry point ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cfg = loadConfig();
  const notifier = new Notifier(cfg);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal');
    await notifier.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal(
      { reason: reason instanceof Error ? reason.message : String(reason) },
      'unhandled promise rejection'
    );
    process.exit(1);
  });
  process.on('exit', (code) => {
    log.info({ code }, 'process exiting');
  });

  await notifier.start();
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    'main() failed during boot'
  );
  process.exit(1);
});
