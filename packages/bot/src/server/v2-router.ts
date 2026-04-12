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
import { createHash } from 'node:crypto';
import { childLogger } from './logger.js';
import { cache } from './cache.js';
import type { GridBotDB } from '../database/db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { signToken, verifyToken } from '../auth/jwt.js';
import { encryptCredentialFields } from '../auth/crypto.js';
import { GRVTClient, type GrvtClientCreds } from '../api/client.js';
import { invalidateGrvtClient } from '../api/grvt-client-factory.js';

// Augment Express Request to carry the authenticated user id set
// by the JWT middleware. Every protected handler reads req.userId.
declare module 'express-serve-static-core' {
  interface Request {
    userId?: number;
  }
}

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
    userId: number;
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
  closeBot(botId: number): Promise<void>;
  updateBotRange(botId: number, lowerPrice: number, upperPrice: number): Promise<void>;
  previewBotRangeUpdate(
    botId: number,
    lowerPrice: number,
    upperPrice: number
  ): Promise<unknown>;
  // C.3: invalidate the cached per-user GRVT client + refresh the
  // injected client on every running bot owned by this user. Called
  // after the user rotates their credentials so live bots pick up
  // the new keys without a restart.
  rebindGrvtClient?(userId: number): Promise<void>;
}

export interface V2RouterDeps {
  db: Database.Database;
  // Multi-tenant: high-level wrapper for user/credential/terms CRUD.
  gridBotDb: GridBotDB;
  grvtClient: GrvtClient;
  engineOps: EngineOps;
  // Legacy single-tenant API key. Still accepted for backward compat
  // (admin tools, scripts) but new clients should use JWT via /auth.
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
// Multi-tenant: prefers JWT in Authorization header. Falls back to
// the legacy X-Api-Key header (which assumes admin user_id=1) for
// backward compatibility with scripts and the migration window.
// Either way, sets req.userId so downstream handlers can scope.
function makeAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Try JWT first.
    const authHeader = req.header('authorization') || '';
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (m) {
      const payload = verifyToken(m[1]!);
      if (payload) {
        req.userId = payload.userId;
        return next();
      }
      // Bearer present but invalid — fail fast, don't fall through.
      log.warn({ ip: req.ip, path: req.path }, 'rejected v2 request: invalid/expired JWT');
      return res.status(401).json({ error: 'invalid or expired token' });
    }

    // Legacy API key fallback. Assumes admin owner = user 1.
    const provided = req.header('x-api-key');
    if (provided && provided === apiKey) {
      req.userId = 1;
      return next();
    }

    log.warn({ ip: req.ip, path: req.path }, 'rejected unauthenticated v2 request');
    return res.status(401).json({
      error: 'unauthorized',
      hint: 'send Authorization: Bearer <jwt> or X-Api-Key (legacy)',
    });
  };
}

// Bot ownership guard. Throws (caught by asyncHandler) if the bot
// doesn't exist or belongs to a different user. Returns the bot row
// for downstream use so handlers don't have to re-fetch.
async function requireBotOwnership(
  db: Database.Database,
  botId: number,
  userId: number
): Promise<{ id: number; user_id: number | null; pair: string; status: string }> {
  const row = await dbGet<{ id: number; user_id: number | null; pair: string; status: string }>(
    db,
    `SELECT id, user_id, pair, status FROM grid_bots WHERE id = ?`,
    [botId]
  );
  if (!row) {
    const e = new Error('bot not found') as Error & { status?: number };
    e.status = 404;
    throw e;
  }
  // Legacy rows with NULL user_id are treated as owned by user 1
  // (the owner) since the migration backfill targets user 1.
  const ownerId = row.user_id ?? 1;
  if (ownerId !== userId) {
    const e = new Error('forbidden') as Error & { status?: number };
    e.status = 403;
    throw e;
  }
  return row;
}

// Admin guard for /admin/* endpoints. Reads is_admin from users.
function makeAdminGuard(gridBotDb: GridBotDB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const u = await gridBotDb.getUserById(req.userId);
    if (!u || !u.is_admin) {
      return res.status(403).json({ error: 'admin required' });
    }
    return next();
  };
}

// ─── Error wrapper ─────────────────────────────────────────────────────
// Catches thrown errors and converts them to clean JSON responses.
// Errors with a numeric `status` property (e.g. from requireBotOwnership)
// produce that status code; everything else is a 500.
type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err: Error & { status?: number }) => {
      if (res.headersSent) return next(err);
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? 'internal_error' : err.message || 'request failed',
        message: err.message,
      });
    });
  };
}

// ─── The router ────────────────────────────────────────────────────────
export function createV2Router(deps: V2RouterDeps): Router {
  const { db, gridBotDb, grvtClient, engineOps, apiKey } = deps;
  const router = Router();

  // ─── Public auth endpoints (NO middleware) ──────────────────────
  // Register these BEFORE the auth middleware so signup/login don't
  // require a token. Order matters: anything declared after the
  // router.use() below is protected.

  // Hard-coded TOS shown at signup. Versioned so we can audit which
  // version each user accepted. When you change the text, bump the
  // version string AND update the corresponding terms_text in the
  // dashboard signup form so the hash matches what was shown.
  const SIGNUP_TOS_VERSION = '2026-04-09-v1';
  const SIGNUP_TOS_TEXT = `By creating an account you confirm that:
- This software trades real cryptocurrency on GRVT perpetual futures.
- You can lose up to 100% of your invested capital. Leveraged trading carries significant risk.
- The operator of this service is NOT a financial advisor, broker, or custodian. You are solely responsible for your trades.
- The operator does NOT touch your funds. You provide your own GRVT API credentials and the bot trades on your sub-account.
- No profit guarantees of any kind are made or implied.
- The software is provided as-is, without warranty. Bugs, downtime, or exchange issues may cause losses.
- You will not hold the operator liable for any losses.`;

  // POST /api/v2/auth/signup — public.
  router.post('/auth/signup', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid email' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password too short (min 8 chars)' });
    }
    const existing = await gridBotDb.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'email already registered' });
    }
    const password_hash = await hashPassword(password);
    // First user becomes admin automatically.
    const userCount = await gridBotDb.countUsers();
    const userId = await gridBotDb.createUser({
      email,
      password_hash,
      is_admin: userCount === 0,
    });
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.ip ||
      null;
    const userAgent = req.header('user-agent') || null;
    await gridBotDb.insertTermsAcceptance({
      user_id: userId,
      context: 'signup',
      context_ref: null,
      ip_address: ipAddress,
      user_agent: userAgent,
      terms_version: SIGNUP_TOS_VERSION,
      terms_text: SIGNUP_TOS_TEXT,
      terms_text_hash: createHash('sha256').update(SIGNUP_TOS_TEXT).digest('hex'),
    });
    log.info({ userId, email, isAdmin: userCount === 0 }, 'user signed up');
    res.json({
      token: signToken(userId),
      userId,
      isAdmin: userCount === 0,
      hasGrvtCreds: false,
    });
    return;
  }));

  // POST /api/v2/auth/login — public.
  router.post('/auth/login', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const user = await gridBotDb.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'invalid email or password' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid email or password' });
    }
    await gridBotDb.updateUserLastLogin(user.id);
    const hasGrvtCreds = await gridBotDb.hasGrvtCredentials(user.id);
    log.info({ userId: user.id, email }, 'user logged in');
    res.json({
      token: signToken(user.id),
      userId: user.id,
      isAdmin: !!user.is_admin,
      hasGrvtCreds,
    });
    return;
  }));

  // GET /api/v2/auth/tos — public, lets the dashboard fetch the
  // current TOS text + version so signup form shows the same string
  // we'll hash on the server side.
  router.get('/auth/tos', (_req, res) => {
    res.json({ version: SIGNUP_TOS_VERSION, text: SIGNUP_TOS_TEXT });
  });

  // ─── Protected endpoints below this line ───────────────────────
  // All endpoints below require either Bearer JWT (preferred) or
  // legacy X-Api-Key header (admin/scripts).
  router.use(makeAuthMiddleware(apiKey));

  // ── GET /api/v2/auth/me ────────────────────────────────────────
  // Returns the authenticated user's profile + whether they have
  // GRVT credentials configured (so the dashboard can decide if it
  // should redirect to onboarding).
  router.get('/auth/me', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const user = await gridBotDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const hasGrvtCreds = await gridBotDb.hasGrvtCredentials(userId);
    res.json({
      id: user.id,
      email: user.email,
      isAdmin: !!user.is_admin,
      hasGrvtCreds,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    });
    return;
  }));

  // ── POST /api/v2/auth/grvt-credentials ─────────────────────────
  // Save (or update) the user's GRVT credentials. Encrypts each
  // field with AES-256-GCM before persisting.
  //
  // C.2: before saving, the credentials are verified against the real
  // GRVT API with a transient client: login() + getBalance(). Only on
  // success the row is written with last_test_ok=1. On failure the
  // row is NOT saved — the user sees the exact GRVT error instead of
  // the previous "save now, fail later with cryptic message at bot
  // creation" flow.
  router.post('/auth/grvt-credentials', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = (req.body ?? {}) as {
      apiKey?: unknown;
      apiSecret?: unknown;
      tradingAddress?: unknown;
      accountId?: unknown;
      subAccountId?: unknown;
    };
    const apiKey = String(body.apiKey ?? '').trim();
    const apiSecret = String(body.apiSecret ?? '').trim();
    const tradingAddress = String(body.tradingAddress ?? '').trim();
    const accountId = String(body.accountId ?? '').trim();
    const subAccountId = String(body.subAccountId ?? '').trim();

    const errors: string[] = [];
    if (!apiKey) errors.push('apiKey is required');
    if (!apiSecret) errors.push('apiSecret is required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(apiSecret)) {
      errors.push('apiSecret must be a 0x-prefixed 32-byte hex string');
    }
    if (!tradingAddress || !/^0x[0-9a-fA-F]{40}$/.test(tradingAddress)) {
      errors.push('tradingAddress must be a 0x-prefixed Ethereum address');
    }
    if (!accountId) errors.push('accountId is required');
    if (!subAccountId) errors.push('subAccountId is required');
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }

    // C.2: verify credentials against GRVT before persisting.
    const plainCreds: GrvtClientCreds = {
      apiKey,
      apiSecret,
      tradingAddress,
      accountId,
      subAccountId,
    };
    let testEquity: string | null = null;
    try {
      const testClient = new GRVTClient(plainCreds);
      const loggedIn = await testClient.login();
      if (!loggedIn) {
        log.warn({ userId }, 'GRVT credential test: login returned false');
        return res.status(400).json({
          error: 'credential_test_failed',
          stage: 'login',
          message: 'GRVT login failed — check apiKey and apiSecret',
        });
      }
      // Authenticated round-trip — validates accountId/subAccountId too.
      const balance = await testClient.getBalance();
      testEquity = balance.total_equity ?? null;
      log.info({ userId, equity: testEquity }, 'GRVT credential test: ok');
    } catch (testErr) {
      const msg = (testErr as Error).message || 'unknown error';
      log.warn({ userId, err: msg }, 'GRVT credential test: failed');
      return res.status(400).json({
        error: 'credential_test_failed',
        stage: 'account_summary',
        message: `GRVT API call failed: ${msg}`,
      });
    }

    try {
      const encrypted = encryptCredentialFields({
        apiKey,
        apiSecret,
        tradingAddress,
        accountId,
        subAccountId,
      });
      await gridBotDb.upsertGrvtCredentials({
        user_id: userId,
        ...encrypted,
        last_test_ok: true,
        last_test_error: null,
      });
      // If the user is rotating keys, the factory cache holds a stale
      // client bound to the old creds. Drop it so subsequent requests
      // pick up the new ones. Also rebind the client on any running
      // bots owned by this user so their next tick authenticates
      // with the fresh keys instead of a stale cookie session.
      invalidateGrvtClient(userId);
      if (engineOps.rebindGrvtClient) {
        try {
          await engineOps.rebindGrvtClient(userId);
        } catch (rebindErr) {
          log.warn(
            { userId, err: (rebindErr as Error).message },
            'rebindGrvtClient failed after credential save; running bots will use stale client until next restart'
          );
        }
      }
      log.info({ userId }, 'GRVT credentials saved (tested ok)');
      res.json({ ok: true, equity: testEquity });
    } catch (err) {
      log.error({ userId, err: (err as Error).message }, 'failed to save GRVT credentials');
      res.status(500).json({
        error: 'save_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── DELETE /api/v2/auth/grvt-credentials ───────────────────────
  // Refuses if the user has running or paused bots — they must be
  // closed first to avoid orphaning bots without credentials.
  router.delete('/auth/grvt-credentials', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const active = await gridBotDb.countActiveBotsForUser(userId);
    if (active > 0) {
      return res.status(409).json({
        error: 'has_active_bots',
        message: `Close all ${active} active bots before disconnecting GRVT credentials`,
      });
    }
    await gridBotDb.deleteGrvtCredentials(userId);
    log.info({ userId }, 'GRVT credentials deleted');
    res.json({ ok: true });
    return;
  }));

  // ── GET /api/v2/bots ──────────────────────────────────────────────
  // List all bots with the fields the dashboard cares about.
  router.get('/bots', asyncHandler(async (req, res) => {
    // Multi-tenant: list only the bots owned by this user. Legacy
    // rows with NULL user_id are treated as user 1's so they keep
    // showing up after the migration.
    const userId = req.userId!;
    const rows = await dbAll(db, `
      SELECT id, pair, direction, leverage, lower_price, upper_price, num_grids,
             investment_usdt, grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
             status, position_size, avg_entry_price, liquidation_price,
             created_at, updated_at,
             compound_pct, compound_threshold_usdt, compound_interval_hours,
             last_compound_at, total_reinvested, original_investment_usdt,
             quantity_per_level,
             safeguard_enabled, safeguard_threshold_pct, safeguard_action
      FROM grid_bots
      WHERE COALESCE(user_id, 1) = ?
      ORDER BY created_at DESC
    `, [userId]);
    res.json({ bots: rows });
    return;
  }));

  // ── GET /api/v2/bots/:id ──────────────────────────────────────────
  router.get('/bots/:id', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);
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
    await requireBotOwnership(db, id, req.userId!);

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
    await requireBotOwnership(db, id, req.userId!);
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
    await requireBotOwnership(db, id, req.userId!);
    const limit = Math.min(parseInt(String(req.query.limit ?? '365'), 10) || 365, 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const snapshots = await dbAll(db, `
      SELECT * FROM daily_snapshots WHERE bot_id = ? ORDER BY date DESC LIMIT ? OFFSET ?
    `, [id, limit, offset]);
    res.json({ snapshots });
    return;
  }));

  // ── GET /api/v2/bots/:id/roundtrips ───────────────────────────────
  // Used for the win-rate stat and the fills feed.
  router.get('/bots/:id/roundtrips', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);
    // Multi-tenant: filter by user_id (added in the migration). Legacy
    // rows with NULL user_id are treated as user 1's.
    const userId = req.userId!;
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const roundtrips = await dbAll(db, `
      SELECT id, buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at
      FROM paired_roundtrips
      WHERE COALESCE(user_id, 1) = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
    const total = await dbGet<{ c: number; sum: number }>(db, `
      SELECT COUNT(*) as c, COALESCE(SUM(profit), 0) as sum
      FROM paired_roundtrips
      WHERE COALESCE(user_id, 1) = ?
    `, [userId]);
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
    await requireBotOwnership(db, id, req.userId!);
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

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
      WHERE bot_id = ?
      ORDER BY event_time DESC
      LIMIT ? OFFSET ?
    `, [id, limit, offset]);

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
    await requireBotOwnership(db, id, req.userId!);

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
      WHERE bot_id = ?
    `, [id]);

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
    await requireBotOwnership(db, id, req.userId!);

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
      WHERE bot_id = ? AND event_time >= ?
      ORDER BY event_time ASC
    `, [id, createdAtNs]);

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

  // ── POST /api/v2/admin/manual-trade ───────────────────────────────
  // Operator escape hatch for one-off position adjustments OUTSIDE the
  // grid logic. Used when the bot's auto-purchase or compound logic
  // got the position wrong and needs a manual correction. Body:
  //   { botId: number, side: 'buy' | 'sell', size: number, slippagePct?: number }
  //
  // Safety guards:
  //   - X-Api-Key required (router middleware)
  //   - hard cap on size (5 ETH max — refuses larger orders)
  //   - aggressive limit price (0.5% from mark by default), GTC
  //   - bot must exist
  //   - returns the GRVT order_id for verification
  //
  // The order is placed independently of the grid — it does NOT touch
  // grid_levels, the engine's monitor will not interfere because it
  // only manages levels (this is just a position adjustment).
  router.post('/admin/manual-trade', asyncHandler(async (req, res) => {
    // Admin only.
    const me = await gridBotDb.getUserById(req.userId!);
    if (!me?.is_admin) {
      return res.status(403).json({ error: 'admin required' });
    }
    const body = (req.body ?? {}) as {
      botId?: unknown;
      side?: unknown;
      size?: unknown;
      slippagePct?: unknown;
    };
    const botId = parseInt(String(body.botId ?? ''), 10);
    const side = String(body.side ?? '');
    const size = parseFloat(String(body.size ?? ''));
    const slippagePct = parseFloat(String(body.slippagePct ?? '0.5'));

    if (!Number.isFinite(botId) || botId <= 0) {
      return res.status(400).json({ error: 'invalid_body', message: 'botId required' });
    }
    if (side !== 'buy' && side !== 'sell') {
      return res.status(400).json({ error: 'invalid_body', message: "side must be 'buy' or 'sell'" });
    }
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'invalid_body', message: 'size must be a positive number' });
    }
    if (size > 5) {
      return res.status(400).json({ error: 'safety_cap', message: 'manual-trade size cap is 5 (refused for safety)' });
    }
    if (!Number.isFinite(slippagePct) || slippagePct <= 0 || slippagePct > 5) {
      return res.status(400).json({ error: 'invalid_body', message: 'slippagePct must be in (0, 5]' });
    }

    const bot = await dbGet<{ id: number; pair: string }>(db, `
      SELECT id, pair FROM grid_bots WHERE id = ?
    `, [botId]);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // Aggressive limit pricing — same pattern the engine's closeBot uses
    // (0.5% on the worse side of market, GTC, executes ~immediately).
    const ticker = await (grvtClient as unknown as { getTicker(p: string): Promise<{ last_price: string }> }).getTicker(bot.pair);
    const lastPrice = parseFloat(ticker.last_price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      return res.status(502).json({ error: 'ticker_unavailable' });
    }

    const slip = slippagePct / 100;
    const aggressivePrice =
      side === 'sell'
        ? Math.floor(lastPrice * (1 - slip) * 100) / 100  // 0.5% below
        : Math.ceil(lastPrice * (1 + slip) * 100) / 100;  // 0.5% above

    const subAccountId = process.env.GRVT_TRADING_ACCOUNT_ID;
    if (!subAccountId) {
      return res.status(500).json({ error: 'sub_account_id_missing' });
    }

    log.warn(
      { botId, side, size, lastPrice, aggressivePrice },
      'admin manual-trade requested'
    );

    try {
      const order = await (grvtClient as unknown as {
        createOrder(p: Record<string, unknown>, allowMarket?: boolean): Promise<{ order_id: string }>;
      }).createOrder({
        sub_account_id: subAccountId,
        instrument: bot.pair,
        size: (Math.floor(size * 10000) / 10000).toString(),
        price: aggressivePrice.toString(),
        side,
        type: 'limit',
        time_in_force: 'gtc',
        metadata: `manual_trade_admin_${Date.now()}`,
      }, true);

      log.warn({ botId, orderId: order.order_id }, 'admin manual-trade order placed');
      res.json({
        ok: true,
        botId,
        side,
        size,
        lastPrice,
        aggressivePrice,
        orderId: order.order_id,
      });
    } catch (err) {
      log.error({ botId, err: (err as Error).message }, 'admin manual-trade failed');
      res.status(500).json({
        error: 'order_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── POST /api/v2/admin/backfill-fills?botId=N ─────────────────────
  // One-shot backfill for a specific bot. Pages getFillHistory backwards
  // using end_time until either GRVT returns nothing, the loop hits
  // maxBatches, or it observes a stall (same oldest fill twice in a row,
  // which means GRVT is ignoring end_time and we'd loop forever).
  //
  // Multi-bot: requires botId so each row can be attributed correctly.
  // Looks up the bot's pair from grid_bots and uses that as the GRVT
  // instrument filter. Idempotent via INSERT OR IGNORE on event_time.
  //
  // Returns counts for the operator to verify how much new data was
  // recovered. Triggered manually via curl with X-Api-Key.
  router.post('/admin/backfill-fills', asyncHandler(async (req, res) => {
    // Admin only.
    const me = await gridBotDb.getUserById(req.userId!);
    if (!me?.is_admin) {
      return res.status(403).json({ error: 'admin required' });
    }
    const botId = parseInt(String(req.query.botId ?? '0'), 10);
    if (!Number.isFinite(botId) || botId <= 0) {
      return res.status(400).json({ error: 'botId query param required' });
    }

    const bot = await dbGet<{ id: number; pair: string }>(db, `
      SELECT id, pair FROM grid_bots WHERE id = ?
    `, [botId]);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const maxBatches = Math.min(
      parseInt(String(req.query.maxBatches ?? '20'), 10) || 20,
      50
    );
    const instrument = bot.pair;
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
            (fill_id, event_time, is_buyer, price, size, fee, created_at, bot_id, instrument)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          eventTime,
          eventTime,
          f.is_buyer ? 1 : 0,
          parseFloat(f.price ?? '0'),
          parseFloat(f.size ?? '0'),
          parseFloat(f.fee ?? '0'),
          new Date(Number(eventTime) / 1_000_000).toISOString(),
          botId,
          instrument,
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
      WHERE bot_id = ?
    `, [botId]);
    res.json({
      ok: true,
      botId,
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
    await requireBotOwnership(db, id, req.userId!);
    const status = String(req.query.status ?? 'all');
    const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    try {
      const where = status === 'all' ? '' : 'AND status = ?';
      const params: unknown[] = [id];
      if (status !== 'all') params.push(status);
      params.push(limit, offset);
      const orders = await dbAll(db, `
        SELECT id, order_id, side, type, quantity, price, status,
               grid_level_id, created_at, updated_at
        FROM orders
        WHERE bot_id = ? ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
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
    await requireBotOwnership(db, id, req.userId!);
    const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 5000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const funding = await dbAll(db, `
      SELECT id, instrument, funding_rate, payment_usdt, position_size,
             funding_time, created_at
      FROM funding_history
      WHERE bot_id = ?
      ORDER BY funding_time DESC
      LIMIT ? OFFSET ?
    `, [id, limit, offset]);

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

    // Computed parameters — must EXACTLY mirror grid-engine.ts +
    // db.createBot() so the wizard preview matches what gets stored
    // and what actually trades. We had three different formulas at
    // one point (validate, calculateGridLevels, db.createBot) and
    // they disagreed: bot 43 hit it on 2026-04-08 — the wizard said
    // 0.0084 ETH/level but the bot ran with 0.05/0.06, drifting the
    // position by 0.17 ETH on a 6-min run. Single source of truth now.
    const spacing = (upper - lower) / (grids - 1);
    const notional = investment * leverage;
    const ORDER_ALLOC = 0.75;
    const midPrice = (upper + lower) / 2;
    const effCap = investment * leverage * ORDER_ALLOC;
    const minSize = pair === 'ETH_USDT_Perp' ? 0.01 : 0.001;
    let qtyPerLevel = Math.max(
      Math.ceil((effCap / grids / midPrice) * 100) / 100,
      0.03
    );
    // Floor on min notional at the lower price (safety net; usually no-op).
    const minNotional = pair === 'ETH_USDT_Perp' ? 20 : 100;
    while (qtyPerLevel * lower < minNotional) {
      qtyPerLevel += minSize;
    }
    qtyPerLevel = Math.round(qtyPerLevel * 100) / 100;
    const profitPerRoundTrip = qtyPerLevel * spacing;

    // Estimated liquidation: simplified — actual depends on funding/fees.
    // For LONG: liq ≈ avg_entry * (1 - 1/leverage * 0.95)
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
      acceptedTermsText: string;
      termsVersion: string;
      safeguard_enabled: boolean;
      safeguard_threshold_pct: number;
      safeguard_action: 'pause' | 'pause_close';
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

    // C.4: liquidation proximity safeguard (optional per-bot). If the user
    // opts in, both threshold_pct and action are required. Validation is
    // strict so downstream code can trust the persisted values.
    const safeguardEnabled = body.safeguard_enabled === true;
    let safeguardThresholdPct: number | null = null;
    let safeguardAction: 'pause' | 'pause_close' | null = null;
    if (safeguardEnabled) {
      safeguardThresholdPct = Number(body.safeguard_threshold_pct);
      if (!Number.isFinite(safeguardThresholdPct) || safeguardThresholdPct <= 0 || safeguardThresholdPct > 50) {
        errors.push('safeguard_threshold_pct must be a number between 0 and 50 when safeguard_enabled=true');
      }
      if (body.safeguard_action !== 'pause' && body.safeguard_action !== 'pause_close') {
        errors.push("safeguard_action must be 'pause' or 'pause_close' when safeguard_enabled=true");
      } else {
        safeguardAction = body.safeguard_action;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }

    try {
      const userId = req.userId!;

      // C.9: reject if user already has an active bot on this pair.
      // Fill attribution breaks silently when two bots share an
      // instrument on the same sub-account.
      const existing = await dbGet<{ c: number }>(
        db,
        `SELECT COUNT(*) as c FROM grid_bots
         WHERE COALESCE(user_id, 1) = ? AND pair = ? AND status IN ('running', 'paused')`,
        [userId, pair]
      );
      if (existing && existing.c > 0) {
        return res.status(409).json({
          error: 'duplicate_instrument',
          message: `You already have an active bot on ${pair}. Close or stop it before creating a new one.`,
        });
      }

      const botId = await engineOps.createBot({
        userId,
        pair,
        direction,
        leverage,
        lowerPrice: lower,
        upperPrice: upper,
        numGrids: grids,
        investmentUSDT: investment,
      });
      log.info({ botId, userId, pair, direction, leverage, grids }, 'bot created (paused)');

      // Persist per-bot risk acceptance if the dashboard sent the
      // exact text + version it showed. The text is hashed and the
      // request IP/UA are stored as audit trail.
      const acceptedText = String(body.acceptedTermsText ?? '').trim();
      const termsVersion = String(body.termsVersion ?? '').trim();
      if (acceptedText && termsVersion) {
        const ipAddress =
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
          req.ip ||
          null;
        const userAgent = req.header('user-agent') || null;
        await gridBotDb.insertTermsAcceptance({
          user_id: userId,
          context: 'create_bot',
          context_ref: botId,
          ip_address: ipAddress,
          user_agent: userAgent,
          terms_version: termsVersion,
          terms_text: acceptedText,
          terms_text_hash: createHash('sha256').update(acceptedText).digest('hex'),
        });
      }

      // Save compound settings if provided
      const compoundPct = Number((req.body as any)?.compound_pct);
      if (Number.isFinite(compoundPct) && compoundPct > 0 && compoundPct <= 100) {
        await dbRun(db, `UPDATE grid_bots SET compound_pct = ? WHERE id = ?`, [compoundPct, botId]);
      }

      // C.4: persist safeguard config if the user opted in. Validation
      // already happened above, so we trust the values here.
      if (safeguardEnabled && safeguardThresholdPct != null && safeguardAction != null) {
        await dbRun(
          db,
          `UPDATE grid_bots
             SET safeguard_enabled = 1,
                 safeguard_threshold_pct = ?,
                 safeguard_action = ?
           WHERE id = ?`,
          [safeguardThresholdPct, safeguardAction, botId]
        );
        log.info(
          { botId, safeguardThresholdPct, safeguardAction },
          'safeguard configured at bot creation'
        );
      }

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
    await requireBotOwnership(db, id, req.userId!);
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
    await requireBotOwnership(db, id, req.userId!);
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

  // ── POST /api/v2/bots/:id/close ───────────────────────────────────
  // FULL stop. Cancels every open order on GRVT, then market-closes the
  // remaining position with a 0.5% aggressive GTC limit (so it crosses
  // the book and fills immediately). Bot status flips to 'stopped' —
  // it stays in the DB for history but no longer counts as an active
  // bot in the overview. Use this when you're done with a bot.
  //
  // Differs from /pause: pause only cancels orders and leaves the
  // position open so you can later /start and resume. /close is final.
  router.post('/bots/:id/close', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);
    try {
      await engineOps.closeBot(id);
      log.info({ botId: id }, 'bot closed via API');
      cache.invalidatePrefix('bots');
      res.json({ id, status: 'stopped' });
    } catch (err) {
      log.error({ botId: id, err: (err as Error).message }, 'bot close failed');
      res.status(500).json({
        error: 'close_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── PATCH /api/v2/bots/:id/compound ─────────────────────────────────
  // Update compound rebalance settings for a bot. compound_pct=0 disables.
  router.patch('/bots/:id/compound', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);

    const { compound_pct, compound_threshold_usdt, compound_interval_hours } = req.body ?? {};

    // Validate compound_pct (required, 0-100)
    if (compound_pct == null || typeof compound_pct !== 'number' || compound_pct < 0 || compound_pct > 100) {
      return res.status(400).json({ error: 'compound_pct must be a number between 0 and 100' });
    }

    const updates: Record<string, number> = { compound_pct };
    if (compound_threshold_usdt != null) {
      if (typeof compound_threshold_usdt !== 'number' || compound_threshold_usdt <= 0) {
        return res.status(400).json({ error: 'compound_threshold_usdt must be > 0' });
      }
      updates.compound_threshold_usdt = compound_threshold_usdt;
    }
    if (compound_interval_hours != null) {
      if (typeof compound_interval_hours !== 'number' || compound_interval_hours < 1) {
        return res.status(400).json({ error: 'compound_interval_hours must be >= 1' });
      }
      updates.compound_interval_hours = compound_interval_hours;
    }

    await dbRun(db, `
      UPDATE grid_bots
      SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [...Object.values(updates), id]);

    cache.invalidatePrefix('bots');
    log.info({ botId: id, ...updates }, 'compound settings updated');
    res.json({ id, ...updates });
    return;
  }));

  // ── POST /api/v2/bots/:id/range/preview ───────────────────────────
  // Read-only dry-run of a range update. Returns the full RangeUpdatePlan
  // (orders to cancel, levels to create, ETH to auto-buy, slippage cost,
  // safety violations) WITHOUT executing anything. The dashboard calls
  // this on every input change to live-update the impact preview.
  //
  // Safety violations (e.g. current price outside new range, deficit
  // exceeds 2 ETH cap) are returned in the plan but the request still
  // succeeds with HTTP 200 — the dashboard surfaces them inline so the
  // user can correct before clicking commit.
  router.post('/bots/:id/range/preview', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);

    const body = (req.body ?? {}) as { lowerPrice?: unknown; upperPrice?: unknown };
    const lowerPrice = parseFloat(String(body.lowerPrice ?? ''));
    const upperPrice = parseFloat(String(body.upperPrice ?? ''));

    if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice)) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'lowerPrice and upperPrice must be finite numbers',
      });
    }

    try {
      const plan = await engineOps.previewBotRangeUpdate(id, lowerPrice, upperPrice);
      res.json({ plan });
    } catch (err) {
      log.error(
        { botId: id, lowerPrice, upperPrice, err: (err as Error).message },
        'range preview failed'
      );
      res.status(500).json({
        error: 'preview_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── POST /api/v2/bots/:id/range ───────────────────────────────────
  // Move/expand/contract the grid range. The engine handles everything:
  //   - validates current price is within the new range (otherwise the
  //     grid has no anchor)
  //   - cancels orders outside the new range
  //   - if more SELL levels are needed than current ETH position, buys
  //     the deficit at market BEFORE placing new sell orders (otherwise
  //     they'd reject for insufficient asset)
  //   - creates new grid_levels for the new range
  //   - places limit orders for them
  //   - updates bot.lower_price / upper_price in DB
  //
  // This is the operator's escape hatch when price drifts out of the
  // current grid: instead of pausing+closing+recreating, they shift
  // the range to wherever price went and resume earning.
  router.post('/bots/:id/range', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);

    const body = (req.body ?? {}) as { lowerPrice?: unknown; upperPrice?: unknown };
    const lowerPrice = parseFloat(String(body.lowerPrice ?? ''));
    const upperPrice = parseFloat(String(body.upperPrice ?? ''));

    if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice)) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'lowerPrice and upperPrice must be finite numbers',
      });
    }
    if (lowerPrice <= 0 || upperPrice <= 0) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'prices must be positive',
      });
    }
    if (lowerPrice >= upperPrice) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'lowerPrice must be strictly less than upperPrice',
      });
    }

    try {
      await engineOps.updateBotRange(id, lowerPrice, upperPrice);
      log.info({ botId: id, lowerPrice, upperPrice }, 'bot range updated via API');
      cache.invalidatePrefix('bots');
      const updated = await dbGet<{
        lower_price: number;
        upper_price: number;
        num_grids: number;
      }>(db, `SELECT lower_price, upper_price, num_grids FROM grid_bots WHERE id = ?`, [id]);
      res.json({
        id,
        lowerPrice: updated?.lower_price ?? lowerPrice,
        upperPrice: updated?.upper_price ?? upperPrice,
        numGrids: updated?.num_grids ?? 0,
      });
    } catch (err) {
      log.error(
        { botId: id, lowerPrice, upperPrice, err: (err as Error).message },
        'bot range update failed'
      );
      res.status(500).json({
        error: 'range_update_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── GET /api/v2/health ────────────────────────────────────────────
  // C.6: real health check — verifies DB read + GRVT API reachability.
  // Returns ok / degraded / down with per-component latency. Docker
  // HEALTHCHECK and external monitors can act on the HTTP status code
  // (200 = ok or degraded, 503 = down).
  router.get('/health', asyncHandler(async (_req, res) => {
    const checks: Record<string, { ok: boolean; ms: number; error?: string }> = {};

    // DB: lightweight SELECT
    const dbStart = Date.now();
    let runningBots = 0;
    try {
      const row = await dbGet<{ c: number }>(db, `SELECT COUNT(*) as c FROM grid_bots WHERE status = 'running'`);
      runningBots = row?.c ?? 0;
      checks.db = { ok: true, ms: Date.now() - dbStart };
    } catch (err) {
      checks.db = { ok: false, ms: Date.now() - dbStart, error: (err as Error).message };
    }

    // GRVT: public ticker (no auth needed)
    const grvtStart = Date.now();
    try {
      await grvtClient.getTicker('BTC_USDT_Perp');
      checks.grvt = { ok: true, ms: Date.now() - grvtStart };
    } catch (err) {
      checks.grvt = { ok: false, ms: Date.now() - grvtStart, error: (err as Error).message };
    }

    const allOk = Object.values(checks).every(c => c.ok);
    const status = allOk ? 'ok' : checks.db?.ok ? 'degraded' : 'down';
    const httpCode = allOk ? 200 : checks.db?.ok ? 200 : 503;

    res.status(httpCode).json({
      status,
      checks,
      uptime: Math.floor(process.uptime()),
      runningBots: checks.db?.ok ? runningBots : null,
      cacheSize: cache.size(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      ts: Date.now(),
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
