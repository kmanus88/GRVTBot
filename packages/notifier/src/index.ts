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
  liqProximityTemplate,
  statusChangeTemplate,
} from './templates.js';
import { WebhookClient } from './webhook.js';

dotenv.config();

const log = childLogger('main');

interface NotifierConfig {
  dbPath: string;
  pollMs: number;
  drawdownPct: number;
  fillBatch: number;
  liqProximityPct: number;       // F.2: global default for liq proximity alerts
  dailySummaryHour: number;
  stateDir: string;
  telegramToken: string | undefined;
  telegramChatId: string | undefined;
  webhookUrl: string | undefined; // F.3
  webhookSecret: string | undefined;
  mutedHoursStart: number;       // F.4: -1 = disabled
  mutedHoursEnd: number;
}

function loadConfig(): NotifierConfig {
  return {
    dbPath: process.env.GRID_BOT_DB ?? '/opt/grvt-grid-bot/data/grid_bot.db',
    pollMs: parseInt(process.env.NOTIFIER_POLL_MS ?? '10000', 10),
    drawdownPct: parseFloat(process.env.NOTIFY_DRAWDOWN_PCT ?? '15'),
    fillBatch: parseInt(process.env.NOTIFY_FILL_BATCH ?? '5', 10),
    liqProximityPct: parseFloat(process.env.NOTIFY_LIQ_PROXIMITY_PCT ?? '15'),
    dailySummaryHour: parseInt(process.env.DAILY_SUMMARY_HOUR_UTC ?? '0', 10),
    stateDir: process.env.NOTIFIER_STATE_DIR ?? '/var/lib/grvt-grid-notifier',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    webhookUrl: process.env.WEBHOOK_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
    mutedHoursStart: parseInt(process.env.MUTED_HOURS_START_UTC ?? '-1', 10),
    mutedHoursEnd: parseInt(process.env.MUTED_HOURS_END_UTC ?? '-1', 10),
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

  private readonly webhook: WebhookClient;

  constructor(cfg: NotifierConfig) {
    this.cfg = cfg;
    this.db = new NotifierDb(cfg.dbPath);
    this.telegram = new TelegramClient(cfg.telegramToken, cfg.telegramChatId);
    this.webhook = new WebhookClient(cfg.webhookUrl, cfg.webhookSecret);
    this.state = new StateStore(cfg.stateDir);
  }

  /**
   * F.4: Check if current UTC hour falls within the muted window.
   * When muted, non-critical alerts (fills, daily summary) are suppressed.
   * Critical alerts (drawdown, liq proximity) always fire.
   */
  private isMuted(): boolean {
    const { mutedHoursStart: start, mutedHoursEnd: end } = this.cfg;
    if (start < 0 || end < 0) return false;
    const hour = new Date().getUTCHours();
    if (start <= end) return hour >= start && hour < end;
    // Wraps midnight: e.g. 22-06
    return hour >= start || hour < end;
  }

  /**
   * F.3: Send to all configured sinks (Telegram + webhook).
   * The webhook always gets the structured event; Telegram gets the
   * formatted text.
   *
   * SECURITY: every alert is tagged with `userId` so /api/v2/alerts on
   * the bot can filter per JWT-authed user. Callers MUST pass the
   * owning user — there is no "system-wide" alert that gets shown to
   * everyone (that would leak one user's drawdown to another).
   */
  private async notify(
    text: string,
    event: {
      type: string;
      userId: number;
      botId?: number;
      pair?: string;
      data?: Record<string, unknown>;
    }
  ): Promise<void> {
    // F.6: log alert to history file before sending
    this.state.appendAlert({
      ts: Date.now(),
      type: event.type,
      userId: event.userId,
      botId: event.botId,
      pair: event.pair,
      message: text,
      data: event.data,
    });

    await Promise.allSettled([
      this.telegram.send(text),
      this.webhook.send({ ...event, message: text }),
    ]);
  }

  /**
   * Helper — every per-bot alert needs to be attributed to a user.
   * Legacy rows with NULL user_id are owned by user 1 (the operator),
   * matching the v2-router COALESCE policy.
   */
  private ownerOf(bot: BotRow): number {
    return bot.user_id ?? 1;
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

    // Bootstrap: on first run (no per-user cursor yet), set cursors so
    // we don't spam every historical roundtrip on startup. Done per
    // user — each owner gets their own starting point.
    const cursors = this.state.get().lastRoundtripIdByUser;
    if (Object.keys(cursors).length === 0) {
      const recent = await this.db.getRoundtripsSince(0, 100_000);
      const bots = await this.db.getAllBots();
      const newCursors: Record<string, number> = {};
      // Initialize a cursor for every known user (operator + any signed-up users)
      for (const b of bots) {
        const uid = String(this.ownerOf(b));
        newCursors[uid] = 0;
      }
      // Advance each user's cursor past their latest historical roundtrip
      for (const rt of recent) {
        const uid = String(rt.user_id ?? 1);
        const prev = newCursors[uid] ?? 0;
        if (rt.id > prev) newCursors[uid] = rt.id;
      }
      const newHwm: Record<string, number> = {};
      for (const b of bots) {
        const uid = String(this.ownerOf(b));
        newHwm[uid] = (newHwm[uid] ?? 0) + (b.investment_usdt + b.total_pnl_usdt);
      }
      this.state.update({
        lastRoundtripIdByUser: newCursors,
        equityHwmByUser: newHwm,
      });
      log.info({ cursors: newCursors, hwm: newHwm }, 'bootstrap state (per-user)');
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
      const muted = this.isMuted();

      // Critical alerts — always fire regardless of muted hours
      await this.checkStatusTransitions(bots);
      await this.checkDrawdown(bots);
      await this.checkLiqProximity(bots); // F.2

      // Non-critical — suppressed during muted hours (F.4)
      if (!muted) {
        await this.checkRoundtrips(bots);
        await this.checkDailySummary(bots);
      }
    } finally {
      this.scheduleNext();
    }
  }

  // ── Roundtrip / fill detection ─────────────────────────────────────
  // SECURITY: batches and cursors are per-user. The previous global
  // cursor + global batch leaked another user's fill counts into the
  // operator's Telegram and held cursor advancement hostage to whoever
  // had the fewest fills.
  private async checkRoundtrips(_bots: BotRow[]): Promise<void> {
    const cursors = { ...this.state.get().lastRoundtripIdByUser };
    // Read from min cursor across users so a slow-tracking user doesn't
    // get permanently skipped. Per-row user attribution gates the rest.
    const minCursor = Object.keys(cursors).length === 0
      ? 0
      : Math.min(...Object.values(cursors));
    const candidates = await this.db.getRoundtripsSince(minCursor, 500);
    if (candidates.length === 0) return;

    // Group by owning user, dropping anything already past that user's cursor.
    const byUser = new Map<string, typeof candidates>();
    for (const rt of candidates) {
      const uid = String(rt.user_id ?? 1);
      const userCursor = cursors[uid] ?? 0;
      if (rt.id <= userCursor) continue;
      const arr = byUser.get(uid) ?? [];
      arr.push(rt);
      byUser.set(uid, arr);
    }

    const threshold = this.cfg.fillBatch;
    let mutated = false;
    for (const [uid, rts] of byUser) {
      if (rts.length < threshold) {
        log.debug({ uid, count: rts.length }, 'below batch threshold, holding');
        continue;
      }
      const text = fillsTemplate(rts);
      await this.notify(text, {
        type: 'fills',
        userId: Number(uid),
        data: { count: rts.length, totalProfit: rts.reduce((s, r) => s + r.profit, 0) },
      });
      cursors[uid] = rts[rts.length - 1]!.id;
      mutated = true;
      log.info({ uid, count: rts.length, cursor: cursors[uid] }, 'sent fill batch');
    }
    if (mutated) this.state.update({ lastRoundtripIdByUser: cursors });
  }

  // ── Status transitions ─────────────────────────────────────────────
  private async checkStatusTransitions(bots: BotRow[]): Promise<void> {
    const lastStatus = { ...this.state.get().lastBotStatus };
    let changed = false;
    for (const bot of bots) {
      const previous = lastStatus[String(bot.id)];
      if (previous && previous !== bot.status) {
        const text = statusChangeTemplate(bot, previous, bot.status);
        await this.notify(text, {
          type: 'status_change',
          userId: this.ownerOf(bot),
          botId: bot.id,
          pair: bot.pair,
          data: { from: previous, to: bot.status },
        });
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

  // ── Drawdown (per-user) ─────────────────────────────────────────────
  // SECURITY: drawdown is computed PER USER. The previous global HWM
  // mixed every user's equity together, so a $1M drop on user B would
  // alert user A with B's number visible in the Telegram batch via the
  // shared notifier and via the shared alert-history.json file.
  private async checkDrawdown(bots: BotRow[]): Promise<void> {
    if (bots.length === 0) return;

    // Aggregate equity per owning user.
    const equityByUser = new Map<string, number>();
    const botsByUser = new Map<string, BotRow[]>();
    for (const b of bots) {
      const uid = String(this.ownerOf(b));
      equityByUser.set(uid, (equityByUser.get(uid) ?? 0) + (b.investment_usdt + b.total_pnl_usdt));
      const arr = botsByUser.get(uid) ?? [];
      arr.push(b);
      botsByUser.set(uid, arr);
    }

    const hwmMap = { ...this.state.get().equityHwmByUser };
    const errorMap = { ...this.state.get().lastErrorHashByUser };
    let hwmChanged = false;
    let errorChanged = false;

    for (const [uid, equity] of equityByUser) {
      const hwm = hwmMap[uid] ?? equity;
      if (equity > hwm) {
        hwmMap[uid] = equity;
        hwmChanged = true;
        continue;
      }
      // F.1: per-bot drawdown override only applies when the user has a
      // single bot (otherwise multiple thresholds would compete).
      const userBots = botsByUser.get(uid) ?? [];
      const threshold = userBots.length === 1 && userBots[0]!.alert_drawdown_pct != null
        ? userBots[0]!.alert_drawdown_pct!
        : this.cfg.drawdownPct;

      const dropPct = hwm > 0 ? ((hwm - equity) / hwm) * 100 : 0;
      if (dropPct >= threshold) {
        const bucket = Math.floor(dropPct / threshold);
        const hash = `dd:${hwm.toFixed(0)}:${bucket}`;
        if (errorMap[uid] === hash) continue;
        const text = drawdownTemplate(equity, hwm, threshold);
        await this.notify(text, {
          type: 'drawdown',
          userId: Number(uid),
          data: { equity, hwm, dropPct, threshold },
        });
        errorMap[uid] = hash;
        errorChanged = true;
        log.warn({ uid, equity, hwm, dropPct }, 'drawdown alert sent');
      }
    }

    if (hwmChanged || errorChanged) {
      this.state.update({
        ...(hwmChanged ? { equityHwmByUser: hwmMap } : {}),
        ...(errorChanged ? { lastErrorHashByUser: errorMap } : {}),
      });
    }
  }

  // ── F.2: Liquidation proximity ─────────────────────────────────────
  private async checkLiqProximity(bots: BotRow[]): Promise<void> {
    const errorMap = { ...this.state.get().lastErrorHashByUser };
    let changed = false;
    for (const bot of bots) {
      if (bot.status !== 'running') continue;
      if (!bot.liquidation_price || bot.liquidation_price <= 0) continue;
      if (!bot.avg_entry_price || bot.avg_entry_price <= 0) continue;

      const markPrice = await this.db.getLastFillPrice(bot.id);
      if (!markPrice) continue;

      // F.1: per-bot threshold overrides global
      const threshold = bot.alert_liq_proximity_pct ?? this.cfg.liqProximityPct;

      const distancePct = bot.direction === 'long'
        ? ((markPrice - bot.liquidation_price) / markPrice) * 100
        : ((bot.liquidation_price - markPrice) / markPrice) * 100;

      if (distancePct <= threshold && distancePct > 0) {
        const owner = this.ownerOf(bot);
        const uid = String(owner);
        // Dedup: per-user, bot+bucket so the alert re-fires if it gets worse
        const bucket = Math.floor(distancePct / 5);
        const hash = `liq:${bot.id}:${bucket}`;
        if (errorMap[uid] === hash) continue;

        const text = liqProximityTemplate(bot, markPrice, bot.liquidation_price, distancePct);
        await this.notify(text, {
          type: 'liq_proximity',
          userId: owner,
          botId: bot.id,
          pair: bot.pair,
          data: { markPrice, liqPrice: bot.liquidation_price, distancePct },
        });
        errorMap[uid] = hash;
        changed = true;
        log.warn({ botId: bot.id, distancePct }, 'liq proximity alert sent');
      }
    }
    if (changed) this.state.update({ lastErrorHashByUser: errorMap });
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
      const yesterday: number | null = snapshot?.equity ?? null;
      await this.notify(dailySummaryTemplate(bot, snapshot, yesterday), {
        type: 'daily_summary',
        userId: this.ownerOf(bot),
        botId: bot.id,
        pair: bot.pair,
      });
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
