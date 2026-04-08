// V2 REST router. New endpoints for the Ultra Dashboard.
//
// These do NOT replace the legacy /api/* endpoints in src/dashboard/server.ts
// — those keep working unchanged. v2 lives at /api/v2/* and is the surface
// the new React dashboard talks to.
//
// Auth: every v2 endpoint requires the X-Api-Key header (matching
// process.env.DASHBOARD_API_KEY). The legacy basic-auth endpoints stay as-is
// for backward compat with the current HTML dashboard.
//
// Caching: hot endpoints (instruments, balance, prices) go through the
// shared TtlCache so dashboard polls don't hammer GRVT.

import { Router, type Request, type Response, type NextFunction } from 'express';
import type Database from 'sqlite3';
import { childLogger } from './logger.js';
import { cache } from './cache.js';

const log = childLogger('v2-router');

// ─── Types ─────────────────────────────────────────────────────────────
interface RawFill {
  event_time?: string;
  is_buyer?: boolean | number;
  price?: string;
  size?: string;
  fee?: string;
}

interface GrvtClient {
  getInstruments(): Promise<unknown[]>;
  getBalance(): Promise<unknown>;
  getTicker(instrument: string): Promise<unknown>;
  getPosition(instrument: string): Promise<unknown>;
  getOpenOrders(instrument?: string): Promise<unknown[]>;
  getKlines(instrument: string, interval?: string, limit?: number): Promise<unknown[]>;
  getFillHistory(limit: number, instrument?: string, endTimeNs?: string): Promise<RawFill[]>;
}

// Structural type for the engine operations the router needs.
// We don't import GridEngine directly to keep this layer free of cycles.
interface EngineOps {
  createBot(config: {
    pair: string;
    direction: 'long' | 'short';
    leverage: number;
    lowerPrice: number;
    upperPrice: number;
    numGrids: number;
    investmentUSDT: number;
  }): Promise<number>;
  startBot(botId: number): Promise<void>;
  pauseBot(botId: number): Promise<void>;
}

export interface V2RouterDeps {
  db: Database.Database;
  grvtClient: GrvtClient;
  engineOps: EngineOps;
  apiKey: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────
function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function dbAll<T = unknown>(db: Database.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function dbGet<T = unknown>(db: Database.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T | undefined);
    });
  });
}

function dbRun(
  db: Database.Database,
  sql: string,
  params: unknown[] = []
): Promise<{ changes: number; lastID: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (this: { changes: number; lastID: number }, err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// ─── Auth middleware ───────────────────────────────────────────────────
function makeAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header('x-api-key');
    if (provided !== apiKey) {
      log.warn({ ip: req.ip, path: req.path }, 'rejected unauthenticated v2 request');
      return res.status(401).json({ error: 'unauthorized', hint: 'set X-Api-Key header' });
    }
    next();
    return;
  };
}

// ─── Error wrapper ─────────────────────────────────────────────────────
type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// ─── The router ────────────────────────────────────────────────────────
export function createV2Router(deps: V2RouterDeps): Router {
  const { db, grvtClient, engineOps, apiKey } = deps;
  const router = Router();

  // All endpoints below require API key
  router.use(makeAuthMiddleware(apiKey));

  // ── GET /api/v2/bots ──────────────────────────────────────────────
  // List all bots with the fields the dashboard cares about.
  router.get('/bots', asyncHandler(async (_req, res) => {
    const rows = await dbAll(db, `
      SELECT id, pair, direction, leverage, lower_price, upper_price, num_grids,
             investment_usdt, grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
             status, position_size, avg_entry_price, liquidation_price,
             created_at, updated_at
      FROM grid_bots
      ORDER BY created_at DESC
    `);
    res.json({ bots: rows });
    return;
  }));

  // ── GET /api/v2/bots/:id ──────────────────────────────────────────
  router.get('/bots/:id', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const bot = await dbGet(db, `SELECT * FROM grid_bots WHERE id = ?`, [id]);
    if (!bot) return res.status(404).json({ error: 'bot not found' });
    res.json({ bot });
    return;
  }));

  // ── GET /api/v2/bots/:id/grid-state ───────────────────────────────
  // The combined payload the GridChart needs in one round-trip:
  // grid levels + active orders + current price + position. Saves the
  // dashboard from making 4 separate requests on every refresh.
  router.get('/bots/:id/grid-state', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });

    const bot = await dbGet<{ pair: string; status: string }>(
      db,
      `SELECT pair, status FROM grid_bots WHERE id = ?`,
      [id]
    );
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // Pull the level rows from the local DB. Grid levels are the source
    // of truth for what the bot WANTS to be doing. The orders array is what
    // GRVT actually has.
    const levels = await dbAll(db, `
      SELECT id, level_index, price, side, quantity, is_filled, pending_replace, order_id
      FROM grid_levels
      WHERE bot_id = ?
      ORDER BY level_index
    `, [id]);

    // Live data from GRVT (cached 2s).
    const [ticker, position, openOrders] = await Promise.all([
      cache.getOrFetch(`ticker:${bot.pair}`, 2_000, () => grvtClient.getTicker(bot.pair)),
      cache.getOrFetch(`position:${bot.pair}`, 2_000, () => grvtClient.getPosition(bot.pair)),
      cache.getOrFetch(`openOrders:${bot.pair}`, 2_000, () => grvtClient.getOpenOrders(bot.pair))
    ]);

    res.json({
      botId: id,
      pair: bot.pair,
      status: bot.status,
      levels,
      ticker,
      position,
      openOrders,
      ts: Date.now()
    });
    return;
  }));

  // ── GET /api/v2/instruments ───────────────────────────────────────
  // Cached 60s — instruments don't change minute-to-minute.
  router.get('/instruments', asyncHandler(async (_req, res) => {
    const data = await cache.getOrFetch('instruments', 60_000, () => grvtClient.getInstruments());
    res.json({ instruments: data });
    return;
  }));

  // ── GET /api/v2/candles ───────────────────────────────────────────
  // Proxy to GRVT klines for the GridChart.
  // Query params:
  //   pair      - instrument name (default: ETH_USDT_Perp)
  //   interval  - GRVT enum (default: CI_1_H). Whitelisted to a few common ones.
  //   limit     - max candles, capped at 1000
  // Cached 30s for 1H+, 5s for sub-hour intervals.
  // Returns ascending (oldest first) — the GRVT API returns newest first;
  // we reverse so Lightweight Charts can append in order.
  router.get('/candles', asyncHandler(async (req, res) => {
    const pair = String(req.query.pair ?? 'ETH_USDT_Perp');
    const interval = String(req.query.interval ?? 'CI_1_H');
    const limitRaw = parseInt(String(req.query.limit ?? '500'), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 500, 10), 1000);

    // Whitelist intervals — anything else is rejected to keep the cache key
    // space bounded and prevent typos from spawning a new cache entry per req.
    const VALID_INTERVALS = new Set([
      'CI_1_M', 'CI_3_M', 'CI_5_M', 'CI_15_M', 'CI_30_M',
      'CI_1_H', 'CI_2_H', 'CI_4_H', 'CI_6_H', 'CI_8_H', 'CI_12_H',
      'CI_1_D', 'CI_3_D', 'CI_1_W'
    ]);
    if (!VALID_INTERVALS.has(interval)) {
      return res.status(400).json({
        error: 'invalid_interval',
        hint: 'use CI_1_M / CI_5_M / CI_15_M / CI_1_H / CI_4_H / CI_1_D etc.'
      });
    }

    // Sub-hour intervals refresh more often, so cache them shorter.
    const ttl = interval.endsWith('_M') ? 5_000 : 30_000;
    const cacheKey = `candles:${pair}:${interval}:${limit}`;
    const candles = await cache.getOrFetch(cacheKey, ttl, async () => {
      const rows = await grvtClient.getKlines(pair, interval, limit);
      // Reverse to ascending order for the chart (GRVT returns newest first).
      return rows.slice().reverse();
    });

    res.json({ pair, interval, candles });
    return;
  }));

  // ── GET /api/v2/balance ───────────────────────────────────────────
  // Cached 2s.
  router.get('/balance', asyncHandler(async (_req, res) => {
    const data = await cache.getOrFetch('balance', 2_000, () => grvtClient.getBalance());
    res.json({ balance: data });
    return;
  }));

  // ── GET /api/v2/bots/:id/trades ───────────────────────────────────
  router.get('/bots/:id/trades', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1000);
    const trades = await dbAll(db, `
      SELECT id, side, quantity, price, fee, round_trip_profit, created_at
      FROM trades
      WHERE bot_id = ?
      ORDER BY id DESC
      LIMIT ?
    `, [id, limit]);
    res.json({ trades });
    return;
  }));

  // ── GET /api/v2/bots/:id/snapshots ────────────────────────────────
  router.get('/bots/:id/snapshots', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const snapshots = await dbAll(db, `
      SELECT * FROM daily_snapshots WHERE bot_id = ? ORDER BY date DESC LIMIT 365
    `, [id]);
    res.json({ snapshots });
    return;
  }));

  // ── GET /api/v2/bots/:id/roundtrips ───────────────────────────────
  // Used for the win-rate stat and the fills feed.
  router.get('/bots/:id/roundtrips', asyncHandler(async (req, res) => {
    void parseInt(String(req.params.id ?? ''), 10);  // accept but ignore for v0
    // paired_roundtrips doesn't have bot_id yet (Phase B migration). For now
    // return all of them — we only have one bot anyway.
    const roundtrips = await dbAll(db, `
      SELECT id, buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at
      FROM paired_roundtrips
      ORDER BY id DESC
      LIMIT 1000
    `);
    const total = await dbGet<{ c: number; sum: number }>(db, `
      SELECT COUNT(*) as c, COALESCE(SUM(profit), 0) as sum FROM paired_roundtrips
    `);
    res.json({ roundtrips, count: total?.c ?? 0, totalProfit: total?.sum ?? 0 });
    return;
  }));

  // ── GET /api/v2/bots/:id/fills ────────────────────────────────────
  // Reads from fills_archive (which is now actively populated by the
  // engine's pollFillArchive loop). Replaces the legacy /trades endpoint
  // for the dashboard's Fills tab — the trades table was frozen since
  // 2026-03-10 and the dashboard was showing stale fees=$0.00 numbers.
  //
  // EVERY field in the response comes from the live GRVT fill_history
  // record. The fee is what GRVT actually charged or refunded for that
  // fill on this account at this volume tier — no fee schedule
  // assumptions, no formulas.
  router.get('/bots/:id/fills', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);

    const fills = await dbAll<{
      id: number;
      fill_id: string;
      event_time: string;
      is_buyer: number;
      price: number;
      size: number;
      fee: number;
      created_at: string;
    }>(db, `
      SELECT id, fill_id, event_time, is_buyer, price, size, fee, created_at
      FROM fills_archive
      ORDER BY event_time DESC
      LIMIT ?
    `, [limit]);

    res.json({ fills });
    return;
  }));

  // ── GET /api/v2/bots/:id/rebate-summary ───────────────────────────
  // Aggregate fee stats over the entire fills_archive. Used by the
  // StatsPanel to show the maker rebate total.
  //
  // SUM(fee) is signed: negative means net rebate (you earned that
  // much from being a maker), positive means net fees paid. The
  // dashboard renders the sign with a + or - prefix and a green/red
  // color so the user always knows which way it's going. The bot is
  // fee-agnostic — what GRVT charges depends on the user's tier and
  // can be a rebate or a fee or both at different times.
  router.get('/bots/:id/rebate-summary', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    void id; // fills_archive is global in v0; ignored until multi-bot migration

    const row = await dbGet<{
      count: number;
      sum_fee: number | null;
      min_fee: number | null;
      max_fee: number | null;
    }>(db, `
      SELECT COUNT(*) AS count,
             COALESCE(SUM(fee), 0) AS sum_fee,
             MIN(fee) AS min_fee,
             MAX(fee) AS max_fee
      FROM fills_archive
    `);

    const sumFee = row?.sum_fee ?? 0;
    const count = row?.count ?? 0;

    res.json({
      count,
      sumFee,                            // signed; negative = rebate earned
      netRebateUsdt: -sumFee,            // positive when user earned, for UI
      avgFee: count > 0 ? sumFee / count : 0,
      minFee: row?.min_fee ?? 0,
      maxFee: row?.max_fee ?? 0,
    });
    return;
  }));

  // ── GET /api/v2/bots/:id/realized-summary ─────────────────────────
  // Real grid_profit, computed by FIFO matching every fill in
  // fills_archive. This REPLACES the legacy bot.grid_profit_usdt
  // column (which was populated from a frozen `paired_roundtrips`
  // table that hasn't been updated since March). Every value is
  // derived from real GRVT fills — no estimation, no heuristic
  // grid-level pairing.
  //
  // Convention:
  //   realizedPnl = Σ (sell_price - buy_price) * matched_size
  //   totalFees   = Σ fee  (signed; negative = net rebate earned)
  //   netPnl      = realizedPnl - totalFees
  //                 (subtracting because positive fee = paid; negative
  //                  fee = earned, which INCREASES net PnL)
  //   roundTrips  = number of FIFO matches (a single SELL can split
  //                 across multiple BUY lots and count as multiple
  //                 round trips)
  //   openSize    = base-currency size still in unmatched BUY lots
  //                 (the currently-open position)
  //   openCost    = USDT spent on those open lots (avg = openCost/openSize)
  //
  // The cost of FIFO over ~1k fills is microseconds — fine to compute
  // on every request, but the dashboard caches with TanStack Query
  // staleTime so it does not hammer the endpoint.
  router.get('/bots/:id/realized-summary', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });

    // ── WHY THIS METHOD ────────────────────────────────────────────
    // For a grid bot, "realized PnL" is NOT computable from balance
    // math (equity - investment - unrealized) because:
    //   1. compound rebalances inflate `bot.investment_usdt` over
    //      time — the column stores the current notional, not the
    //      original cash deposit
    //   2. the user may transfer funds in/out of the sub-account
    //      manually for additional margin
    // Both of those make `current_equity - investment_usdt` meaningless.
    //
    // It's also NOT computable by FIFO over the flat fill stream:
    //   FIFO would match a BUY at $1800 against an unrelated SELL at
    //   $2240, reporting +$440/ETH profit that NEVER actually happened
    //   (that buy was sold against ITS own grid level for +$7).
    //
    // The CORRECT method for a grid bot: pair each SELL with the
    // closest unmatched BUY whose price is lower by *roughly one
    // grid spacing* — that's a real grid round trip. This is what
    // the engine's calculateRealGridProfit() already does on the
    // last ~1000 fills; we now do it over the FULL backfilled
    // fills_archive (post-bot-creation only), so the lifetime
    // number includes everything since the bot was provisioned —
    // including profits that have already been compounded into
    // investment_usdt.
    //
    // Spread window: $3 < spread < $20. Bot 42 has 6.99 USDT spacing,
    // so adjacent-level pairs land in (6, 8); the wider window
    // tolerates dust from non-adjacent pairs without admitting
    // cross-grid noise.

    const bot = await dbGet<{ created_at: string }>(db, `
      SELECT created_at FROM grid_bots WHERE id = ?
    `, [id]);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // SQLite stores created_at as ISO 'YYYY-MM-DD HH:MM:SS' UTC (no zone
    // marker). Convert to nanoseconds to filter event_time, which is
    // GRVT's nanosecond-string format.
    const createdAtMs = Date.parse(bot.created_at + 'Z');
    const createdAtNs = (BigInt(createdAtMs) * 1_000_000n).toString();

    const fills = await dbAll<{
      is_buyer: number;
      price: number;
      size: number;
      fee: number;
      event_time: string;
    }>(db, `
      SELECT is_buyer, price, size, fee, event_time
      FROM fills_archive
      WHERE event_time >= ?
      ORDER BY event_time ASC
    `, [createdAtNs]);

    if (fills.length === 0) {
      res.json({
        gridProfit: 0,
        totalFees: 0,
        netGridProfit: 0,
        pairs: 0,
        avgPerPair: 0,
        fillCount: 0,
        unpairedBuys: 0,
        unpairedSells: 0,
        firstFillAt: null,
        lastFillAt: null,
      });
      return;
    }

    // Walk fills chronologically, maintain a queue of pending buys.
    // For each sell, find the BEST matching pending buy:
    //   - spread > MIN_SPREAD (excludes wash / re-entry / sub-grid noise)
    //   - spread < MAX_SPREAD (excludes cross-grid mismatches)
    //   - prefer the smallest valid spread (closest to grid spacing)
    const MIN_SPREAD = 3;
    const MAX_SPREAD = 20;

    const pendingBuys: Array<{ price: number; size: number }> = [];
    let gridProfit = 0;
    let totalFees = 0;
    let pairs = 0;
    let unpairedSells = 0;

    for (const f of fills) {
      totalFees += f.fee;
      if (f.is_buyer === 1) {
        pendingBuys.push({ price: f.price, size: f.size });
        continue;
      }
      let bestIdx = -1;
      let bestSpread = Infinity;
      for (let i = 0; i < pendingBuys.length; i++) {
        const b = pendingBuys[i]!;
        const spread = f.price - b.price;
        if (spread > MIN_SPREAD && spread < MAX_SPREAD && spread < bestSpread) {
          bestIdx = i;
          bestSpread = spread;
        }
      }
      if (bestIdx >= 0) {
        const b = pendingBuys[bestIdx]!;
        gridProfit += (f.price - b.price) * f.size;
        pairs++;
        pendingBuys.splice(bestIdx, 1);
      } else {
        unpairedSells++;
      }
    }

    res.json({
      gridProfit,                              // gross trade-pair profit
      totalFees,                               // signed; negative = rebate
      netGridProfit: gridProfit - totalFees,   // grid profit AFTER fees
      pairs,                                   // matched grid round trips
      avgPerPair: pairs > 0 ? gridProfit / pairs : 0,
      fillCount: fills.length,
      unpairedBuys: pendingBuys.length,        // open position from unmatched buys
      unpairedSells,                           // sells we couldn't pair (data gaps)
      firstFillAt: fills[0]!.event_time,
      lastFillAt: fills[fills.length - 1]!.event_time,
    });
    return;
  }));

  // ── POST /api/v2/admin/backfill-fills ─────────────────────────────
  // One-shot backfill: pages getFillHistory backwards using end_time
  // until either GRVT returns nothing, the script hits maxBatches, or
  // it observes a stall (same oldest fill twice in a row, which means
  // GRVT is ignoring end_time and we'd loop forever).
  //
  // Idempotent — every fill goes through INSERT OR IGNORE on
  // (event_time) so re-running is safe and a no-op once everything
  // is already in fills_archive.
  //
  // Returns counts for the operator to verify how much new data was
  // recovered. Triggered manually via curl with X-Api-Key.
  router.post('/admin/backfill-fills', asyncHandler(async (req, res) => {
    const maxBatches = Math.min(
      parseInt(String(req.query.maxBatches ?? '20'), 10) || 20,
      50
    );
    const instrument = String(req.query.instrument ?? 'ETH_USDT_Perp');
    const t0 = Date.now();

    let totalFetched = 0;
    let totalInserted = 0;
    let batches = 0;
    let endTime: string | undefined = undefined;
    let lastOldest: string | null = null;
    let stalled = false;

    while (batches < maxBatches) {
      const batch = await grvtClient.getFillHistory(1000, instrument, endTime);
      batches++;
      if (batch.length === 0) break;

      const oldest = batch[batch.length - 1];
      if (!oldest) break;

      // Stall detection: if GRVT silently ignores end_time, we'll see
      // the same oldest event_time twice in a row.
      if (lastOldest !== null && lastOldest === String(oldest.event_time)) {
        stalled = true;
        break;
      }
      lastOldest = String(oldest.event_time);

      for (const f of batch) {
        const eventTime = String(f.event_time ?? '');
        if (!eventTime) continue;
        totalFetched++;
        const result = await dbRun(db, `
          INSERT OR IGNORE INTO fills_archive
            (fill_id, event_time, is_buyer, price, size, fee, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          eventTime,
          eventTime,
          f.is_buyer ? 1 : 0,
          parseFloat(f.price ?? '0'),
          parseFloat(f.size ?? '0'),
          parseFloat(f.fee ?? '0'),
          new Date(Number(eventTime) / 1_000_000).toISOString(),
        ]);
        if ((result?.changes ?? 0) > 0) totalInserted++;
      }

      // Subtract 1 ns so the next batch is strictly older.
      // We do NOT break on `batch.length < 1000` because GRVT's
      // fill_history endpoint silently caps each call at ~430 fills
      // even when limit=1000. We rely on the empty-batch and stall
      // detection to terminate instead.
      const oldestEventTime = String(oldest.event_time ?? '');
      if (!oldestEventTime) break;
      endTime = (BigInt(oldestEventTime) - 1n).toString();
    }

    const after = await dbGet<{
      count: number;
      sum_fee: number;
      min_fee: number;
      max_fee: number;
    }>(db, `
      SELECT COUNT(*) AS count,
             COALESCE(SUM(fee), 0) AS sum_fee,
             MIN(fee) AS min_fee,
             MAX(fee) AS max_fee
      FROM fills_archive
    `);
    res.json({
      ok: true,
      instrument,
      batches,
      maxBatches,
      stalled,
      totalFetched,
      totalInserted,
      durationMs: Date.now() - t0,
      fillArchiveAfter: after,
    });
    return;
  }));

  // ── GET /api/v2/bots/:id/orders ───────────────────────────────────
  // Local DB orders (the GRVT live open orders are surfaced via grid-state).
  // The orders table can be SQLITE_CORRUPT on legacy databases — we wrap
  // the query and degrade gracefully so the dashboard still loads.
  router.get('/bots/:id/orders', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const status = String(req.query.status ?? 'all');
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);

    try {
      const where = status === 'all' ? '' : 'AND status = ?';
      const params: unknown[] = [id];
      if (status !== 'all') params.push(status);
      params.push(limit);
      const orders = await dbAll(db, `
        SELECT id, order_id, side, type, quantity, price, status,
               grid_level_id, created_at, updated_at
        FROM orders
        WHERE bot_id = ? ${where}
        ORDER BY id DESC
        LIMIT ?
      `, params);
      res.json({ orders });
      return;
    } catch (err) {
      // SQLITE_CORRUPT or schema mismatch on legacy DBs — return empty
      // instead of 500 so the tab can render an empty state.
      log.warn({ err: (err as Error).message }, 'orders query failed');
      res.json({ orders: [], degraded: true, hint: (err as Error).message });
      return;
    }
  }));

  // ── GET /api/v2/bots/:id/funding ──────────────────────────────────
  router.get('/bots/:id/funding', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 5000);

    const funding = await dbAll(db, `
      SELECT id, instrument, funding_rate, payment_usdt, position_size,
             funding_time, created_at
      FROM funding_history
      WHERE bot_id = ?
      ORDER BY funding_time DESC
      LIMIT ?
    `, [id, limit]);

    const totals = await dbGet<{ count: number; total: number }>(db, `
      SELECT COUNT(*) as count, COALESCE(SUM(payment_usdt), 0) as total
      FROM funding_history
      WHERE bot_id = ?
    `, [id]);

    res.json({
      funding,
      count: totals?.count ?? 0,
      totalPaymentUsdt: totals?.total ?? 0,
    });
    return;
  }));

  // ── POST /api/v2/bots/validate ────────────────────────────────────
  // DRY-RUN endpoint for the Create Bot Wizard. Validates the proposed
  // config and returns the computed grid parameters (spacing, qty/level,
  // estimated profit per round-trip, liquidation distance) WITHOUT
  // actually creating a bot or placing any orders. The wizard uses this
  // for the live preview in steps 3 and 4.
  //
  // The actual bot creation flow goes via a separate POST /bots endpoint
  // that lands in B.5.1 — kept off the v0 surface to protect the live
  // bot from accidental sibling-bot creation during dashboard development.
  router.post('/bots/validate', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Partial<{
      pair: string;
      direction: 'long' | 'short';
      lower_price: number;
      upper_price: number;
      num_grids: number;
      investment_usdt: number;
      leverage: number;
    }>;

    const errors: string[] = [];
    const pair = String(body.pair ?? '').trim();
    if (!pair) errors.push('pair is required');
    const direction = body.direction === 'short' ? 'short' : 'long';
    const lower = Number(body.lower_price);
    const upper = Number(body.upper_price);
    const grids = Number(body.num_grids);
    const investment = Number(body.investment_usdt);
    const leverage = Number(body.leverage);

    if (!Number.isFinite(lower) || lower <= 0) errors.push('lower_price must be > 0');
    if (!Number.isFinite(upper) || upper <= 0) errors.push('upper_price must be > 0');
    if (lower >= upper) errors.push('lower_price must be < upper_price');
    if (!Number.isInteger(grids) || grids < 2 || grids > 95) {
      errors.push('num_grids must be an integer between 2 and 95');
    }
    if (!Number.isFinite(investment) || investment <= 0) errors.push('investment_usdt must be > 0');
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 50) {
      errors.push('leverage must be between 1 and 50');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }

    // Computed parameters — must mirror grid-engine.ts so the wizard preview
    // matches reality. If the engine ever changes its math, update this too.
    const spacing = (upper - lower) / (grids - 1);
    const notional = investment * leverage;
    const qtyPerLevel = notional / grids / ((upper + lower) / 2);
    const profitPerRoundTrip = qtyPerLevel * spacing;

    // Estimated liquidation: simplified — actual depends on funding/fees.
    // For LONG: liq ≈ avg_entry * (1 - 1/leverage * 0.95)
    const midPrice = (upper + lower) / 2;
    const liquidationEstimate =
      direction === 'long'
        ? midPrice * (1 - (1 / leverage) * 0.95)
        : midPrice * (1 + (1 / leverage) * 0.95);
    const liqDistancePct = ((midPrice - liquidationEstimate) / midPrice) * 100;

    // Tier 1 GRVT account is capped to 100 open orders. We hard-cap at 95
    // here too so there's room for replacement orders during round-trips.
    const overOrderCap = grids > 95;

    res.json({
      valid: true,
      pair,
      direction,
      input: { lower, upper, grids, investment, leverage },
      computed: {
        spacing: round(spacing, 4),
        spacingPct: round((spacing / midPrice) * 100, 3),
        qtyPerLevel: round(qtyPerLevel, 6),
        notional: round(notional, 2),
        profitPerRoundTrip: round(profitPerRoundTrip, 4),
        midPrice: round(midPrice, 2),
        liquidationEstimate: round(liquidationEstimate, 2),
        liqDistancePct: round(liqDistancePct, 2),
      },
      warnings: [
        ...(overOrderCap ? ['num_grids over GRVT Tier 1 cap (95)'] : []),
        ...(leverage > 20 ? ['leverage > 20x: liquidation risk is high'] : []),
      ],
    });
    return;
  }));

  // ── POST /api/v2/bots ─────────────────────────────────────────────
  // Create a new grid bot. The bot is always created in 'paused' state —
  // no orders are placed on GRVT until the user explicitly starts it via
  // POST /api/v2/bots/:id/start. This decouples "configure" from "trade"
  // so a bad config can never accidentally launch real orders.
  //
  // Re-validates the input server-side (the wizard already calls
  // /bots/validate but never trust the client).
  router.post('/bots', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Partial<{
      pair: string;
      direction: 'long' | 'short';
      lower_price: number;
      upper_price: number;
      num_grids: number;
      investment_usdt: number;
      leverage: number;
    }>;

    const errors: string[] = [];
    const pair = String(body.pair ?? '').trim();
    if (!pair) errors.push('pair is required');
    const direction = body.direction === 'short' ? 'short' : 'long';
    const lower = Number(body.lower_price);
    const upper = Number(body.upper_price);
    const grids = Number(body.num_grids);
    const investment = Number(body.investment_usdt);
    const leverage = Number(body.leverage);

    if (!Number.isFinite(lower) || lower <= 0) errors.push('lower_price must be > 0');
    if (!Number.isFinite(upper) || upper <= 0) errors.push('upper_price must be > 0');
    if (lower >= upper) errors.push('lower_price must be < upper_price');
    if (!Number.isInteger(grids) || grids < 2 || grids > 95) {
      errors.push('num_grids must be an integer between 2 and 95');
    }
    if (!Number.isFinite(investment) || investment <= 0) errors.push('investment_usdt must be > 0');
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 50) {
      errors.push('leverage must be between 1 and 50');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }

    try {
      const botId = await engineOps.createBot({
        pair,
        direction,
        leverage,
        lowerPrice: lower,
        upperPrice: upper,
        numGrids: grids,
        investmentUSDT: investment,
      });
      log.info({ botId, pair, direction, leverage, grids }, 'bot created (paused)');
      // Invalidate the bots cache so the next /bots GET sees the new row.
      cache.invalidatePrefix('bots');
      res.status(201).json({ id: botId, status: 'paused' });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'bot creation failed');
      res.status(500).json({
        error: 'create_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── POST /api/v2/bots/:id/start ───────────────────────────────────
  // Start a paused bot. The engine's startBot() detects existing GRVT
  // state (orders + position) and either RESUMES (rebinds without new
  // orders) or FRESH-STARTS (places initial orders). The reentrant guard
  // shipped in commit 1936367 prevents accidental double-bootstrap.
  router.post('/bots/:id/start', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    try {
      await engineOps.startBot(id);
      log.info({ botId: id }, 'bot started via API');
      cache.invalidatePrefix('bots');
      res.json({ id, status: 'running' });
    } catch (err) {
      log.error({ botId: id, err: (err as Error).message }, 'bot start failed');
      res.status(500).json({
        error: 'start_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── POST /api/v2/bots/:id/pause ───────────────────────────────────
  // Pause a running bot. The engine's pauseBot() cancels all open orders
  // on GRVT before flipping the DB status — call this when you want to
  // STOP trading but keep the bot's history. Use it before any config
  // change.
  router.post('/bots/:id/pause', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    try {
      await engineOps.pauseBot(id);
      log.info({ botId: id }, 'bot paused via API');
      cache.invalidatePrefix('bots');
      res.json({ id, status: 'paused' });
    } catch (err) {
      log.error({ botId: id, err: (err as Error).message }, 'bot pause failed');
      res.status(500).json({
        error: 'pause_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── GET /api/v2/health ────────────────────────────────────────────
  // Detailed health for the dashboard. Different shape from /api/health
  // (which is for systemd / external monitors).
  router.get('/health', asyncHandler(async (_req, res) => {
    const botCount = await dbGet<{ c: number }>(db, `SELECT COUNT(*) as c FROM grid_bots WHERE status = 'running'`);
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      runningBots: botCount?.c ?? 0,
      cacheSize: cache.size(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      ts: Date.now()
    });
    return;
  }));

  // Error handler — turn anything thrown by an asyncHandler into JSON
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err: err.message, stack: err.stack }, 'v2 endpoint error');
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  return router;
}
