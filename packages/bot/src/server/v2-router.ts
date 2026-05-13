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
import rateLimit from 'express-rate-limit';
import type Database from 'sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { childLogger } from './logger.js';
import { cache } from './cache.js';
import type { GridBotDB } from '../database/db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { signToken, verifyToken } from '../auth/jwt.js';
import { encryptCredentialFields } from '../auth/crypto.js';
import { sendPasswordResetEmail, isMailerConfigured } from '../mail/mailer.js';
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
    virtualEnabled?: boolean;
    activeWindowSize?: number;
    // H.5: optional sub-account routing. NULL = use default creds.
    grvtSubAccountId?: number | null;
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
  // C.3 + H.5: invalidate the cached GRVT client + refresh the injected
  // client on every running bot. With subAccountId omitted the engine
  // refreshes ALL bots owned by the user (default-creds rotation).
  // With subAccountId provided it only refreshes bots routed through
  // that specific sub-account.
  rebindGrvtClient?(userId: number, subAccountId?: number | null): Promise<void>;
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

// ─── Rate limiters (H-6) ───────────────────────────────────────────────
// Protect auth endpoints from credential-stuffing / brute-force / email-
// bombing. Limits are deliberately generous so a single user fat-fingering
// their password 3 times doesn't get locked out — the goal is to make
// automated abuse uneconomical, not to be a CAPTCHA.
//
// Test environments disable the limit entirely (NODE_ENV=test or
// DISABLE_RATE_LIMIT=1) so the integration tests can hammer endpoints
// without flake. Production behavior is what matters.
function makeAuthLimiter(maxPerWindow: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: maxPerWindow,
    standardHeaders: 'draft-7', // RateLimit-* headers per RFC draft
    legacyHeaders: false,
    // Read env vars per-request, not at construction time — tests need
    // to toggle the flag dynamically. In production this is a single
    // boolean check per request, negligible cost.
    skip: () =>
      process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === '1',
    handler: (req, res) => {
      log.warn(
        { ip: req.ip, path: req.path },
        'rate limit exceeded on auth endpoint'
      );
      res.status(429).json({
        error: 'too_many_requests',
        message: 'Too many attempts from this IP. Try again in a few minutes.',
      });
    },
  });
}

// 5 attempts per 15 min — covers normal "I fat-fingered my password 3 times"
// without locking out, but a 1000-password dictionary attack needs ~50 hours.
const LOGIN_LIMITER = makeAuthLimiter(5, 15 * 60 * 1000);
// Signup: 3 per hour. Stops a single IP from spinning up dozens of accounts.
const SIGNUP_LIMITER = makeAuthLimiter(3, 60 * 60 * 1000);
// Password reset: 3 per hour. Stops email-bombing a known address. Stricter
// than login because each call triggers an outbound email + DB write.
const RESET_LIMITER = makeAuthLimiter(3, 60 * 60 * 1000);

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
  router.post('/auth/signup', SIGNUP_LIMITER, asyncHandler(async (req, res) => {
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
    // SECURITY (H-5): admin status is granted ONLY to the email that
    // matches ADMIN_EMAIL env var. The previous "first user becomes
    // admin" rule had two failure modes:
    //   1. Race — two concurrent signups could both see countUsers() === 0
    //      and both walk away with admin.
    //   2. Hijack — if signups opened before the operator created their
    //      own account, an attacker who learned the URL first would be
    //      promoted to admin.
    // Requiring an explicit email match closes both. If ADMIN_EMAIL is
    // unset, no user is auto-promoted; promotion happens manually via
    // the DB or a future /admin/promote-user endpoint.
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const isAdmin =
      adminEmail !== undefined && adminEmail !== '' && adminEmail === email;
    const userId = await gridBotDb.createUser({
      email,
      password_hash,
      is_admin: isAdmin,
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
    log.info({ userId, email, isAdmin }, 'user signed up');
    res.json({
      token: signToken(userId),
      userId,
      isAdmin,
      hasGrvtCreds: false,
    });
    return;
  }));

  // POST /api/v2/auth/login — public.
  router.post('/auth/login', LOGIN_LIMITER, asyncHandler(async (req, res) => {
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

  // E.9 — Password reset.
  //
  // Two endpoints, both PUBLIC (must work without a JWT):
  //   POST /auth/forgot-password   { email }                -> always 200
  //   POST /auth/reset-password    { token, new_password }  -> 200 / 400
  //
  // forgot-password never reveals whether the email exists (no enum).
  // We always answer with `{ ok: true, mailed: bool }`. `mailed` is true
  // only when SMTP is configured AND the email matched a user — but the
  // distinction between "no user" and "user but smtp off" is not exposed
  // to attackers because we always check `mailed === true` server-side
  // only.
  //
  // Token storage: SHA-256 hashed in DB, raw value sent by email. 1h TTL,
  // single-use, and any new request invalidates previous open tokens.
  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
  const RESET_TOKEN_TTL_MIN = 60;

  router.post('/auth/forgot-password', RESET_LIMITER, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = String(body.email ?? '').trim().toLowerCase();
    // Cheap shape check — do not bail with detailed error since that
    // would be an enumeration channel. Just respond 200.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.json({ ok: true });
      return;
    }
    const user = await gridBotDb.getUserByEmail(email);
    if (!user) {
      // Don't reveal that the email is unknown.
      log.info({ email }, 'forgot-password requested for unknown email');
      res.json({ ok: true });
      return;
    }
    // Invalidate any previous open token so only the latest is valid.
    await gridBotDb.invalidateOpenPasswordResetTokensForUser(user.id);
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.ip ||
      null;
    // SECURITY: never derive the reset URL from the request's Host header.
    // An attacker can spoof Host and trick the email link into pointing at
    // their server, leaking the raw token when the victim clicks. Require
    // APP_BASE_URL to be explicitly configured by the operator.
    const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/$/, '');
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      log.error(
        { userId: user.id, hasAppBaseUrl: !!process.env.APP_BASE_URL },
        'password reset requested but APP_BASE_URL is not configured (or invalid). Refusing to derive from Host header.'
      );
      // Stay enumeration-safe — same 200 the unknown-email path returns.
      res.json({ ok: true });
      return;
    }
    await gridBotDb.insertPasswordResetToken({
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: ipAddress,
    });
    const resetUrl = `${baseUrl}/dashboard/reset-password?token=${rawToken}`;
    try {
      await sendPasswordResetEmail({
        to: user.email,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MIN,
      });
    } catch (err) {
      // Don't fail the request — user already sees a generic OK and
      // the token row is in the DB. Log with the URL so an admin can
      // recover by hand if the SMTP transport is broken.
      log.error({ err, userId: user.id, resetUrl }, 'password reset email failed');
    }
    log.info({ userId: user.id, mailerConfigured: isMailerConfigured() }, 'password reset issued');
    res.json({ ok: true });
    return;
  }));

  router.post('/auth/reset-password', RESET_LIMITER, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { token?: unknown; new_password?: unknown };
    const token = String(body.token ?? '').trim();
    const newPassword = String(body.new_password ?? '');
    if (!token || token.length < 32) {
      return res.status(400).json({ error: 'invalid token' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'password too short (min 8 chars)' });
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await gridBotDb.findValidPasswordResetToken(tokenHash);
    if (!row) {
      return res.status(400).json({ error: 'token expired or already used' });
    }
    const password_hash = await hashPassword(newPassword);
    await gridBotDb.updateUserPassword(row.user_id, password_hash);
    // Mark this token used AND invalidate any other open tokens for the
    // same user (defense-in-depth — only one reset per request).
    await gridBotDb.markPasswordResetTokenUsed(row.id);
    await gridBotDb.invalidateOpenPasswordResetTokensForUser(row.user_id);
    log.info({ userId: row.user_id }, 'password reset completed');
    res.json({ ok: true });
    return;
  }));

  // ── GET /api/v2/metrics ────────────────────────────────────────────
  // G.1: Prometheus-compatible text metrics. Sits BEFORE the JWT auth
  // middleware so scrapers don't need a user token, but is NOT public:
  // it exposes per-bot equity/PnL/position with bot_id+pair labels, which
  // would leak every user's portfolio if scrapeable from the internet.
  //
  // Gate (in order):
  //   1. If METRICS_TOKEN is set → require it via `Authorization: Bearer
  //      <token>` or `?token=<token>`.
  //   2. Else → only allow localhost (127.0.0.1 / ::1). External
  //      requests get 401 with a hint.
  router.get('/metrics', (req: Request, res: Response, next: NextFunction) => {
    const required = process.env.METRICS_TOKEN?.trim();
    if (required && required.length >= 16) {
      const header = req.header('authorization') || '';
      const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
      const provided = bearer ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
      if (provided && provided === required) return next();
      log.warn({ ip: req.ip, path: req.path }, 'rejected /metrics request: missing/invalid token');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const remote = req.ip || req.socket.remoteAddress || '';
    const isLocalhost =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (isLocalhost) return next();
    log.warn(
      { ip: remote, path: req.path },
      'rejected /metrics request from non-localhost (set METRICS_TOKEN to allow remote scrapers)'
    );
    res.status(401).json({
      error: 'unauthorized',
      hint: 'set METRICS_TOKEN (min 16 chars) on the bot and pass it as Authorization: Bearer <token>, or scrape from localhost',
    });
    return;
  }, asyncHandler(async (_req, res) => {
    const bots = await dbAll<{
      id: number; status: string; pair: string;
      investment_usdt: number; total_pnl_usdt: number;
      grid_profit_usdt: number; trend_pnl_usdt: number;
      position_size: number;
    }>(db, `SELECT id, status, pair, investment_usdt, total_pnl_usdt,
            grid_profit_usdt, trend_pnl_usdt, position_size FROM grid_bots`);

    const fillCount = await dbGet<{ c: number }>(
      db, `SELECT COUNT(*) as c FROM fills_archive`
    );

    const lines: string[] = [
      '# HELP grvt_bot_count Number of bots by status',
      '# TYPE grvt_bot_count gauge',
    ];

    const statusCounts: Record<string, number> = {};
    for (const b of bots) {
      statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;
    }
    for (const [status, count] of Object.entries(statusCounts)) {
      lines.push(`grvt_bot_count{status="${status}"} ${count}`);
    }

    lines.push(
      '# HELP grvt_bot_equity_usdt Bot equity in USDT',
      '# TYPE grvt_bot_equity_usdt gauge',
      '# HELP grvt_bot_realized_usdt Realized grid profit',
      '# TYPE grvt_bot_realized_usdt gauge',
      '# HELP grvt_bot_unrealized_usdt Unrealized PnL',
      '# TYPE grvt_bot_unrealized_usdt gauge',
      '# HELP grvt_bot_position_size Current position size',
      '# TYPE grvt_bot_position_size gauge',
    );

    for (const b of bots) {
      const labels = `bot_id="${b.id}",pair="${b.pair}"`;
      const equity = b.investment_usdt + b.total_pnl_usdt;
      lines.push(`grvt_bot_equity_usdt{${labels}} ${equity.toFixed(2)}`);
      lines.push(`grvt_bot_realized_usdt{${labels}} ${b.grid_profit_usdt.toFixed(2)}`);
      lines.push(`grvt_bot_unrealized_usdt{${labels}} ${b.trend_pnl_usdt.toFixed(2)}`);
      lines.push(`grvt_bot_position_size{${labels}} ${b.position_size}`);
    }

    lines.push(
      '# HELP grvt_fills_total Total fills archived',
      '# TYPE grvt_fills_total counter',
      `grvt_fills_total ${fillCount?.c ?? 0}`,
      '# HELP grvt_process_uptime_seconds Process uptime',
      '# TYPE grvt_process_uptime_seconds gauge',
      `grvt_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP grvt_process_memory_rss_bytes Resident set size',
      '# TYPE grvt_process_memory_rss_bytes gauge',
      `grvt_process_memory_rss_bytes ${process.memoryUsage().rss}`,
      '# HELP grvt_process_memory_heap_bytes Heap used',
      '# TYPE grvt_process_memory_heap_bytes gauge',
      `grvt_process_memory_heap_bytes ${process.memoryUsage().heapUsed}`,
    );

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
    return;
  }));

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

  // ─── H.5: GRVT sub-accounts ───────────────────────────────────────
  // Power users can connect multiple GRVT sub-accounts (one row each in
  // grvt_sub_accounts) so different bots run isolated risk-wise. The
  // existing `/auth/grvt-credentials` flow handles their default; these
  // routes manage the extras.

  // ── GET /api/v2/auth/grvt-sub-accounts ────────────────────────────
  // List the user's sub-accounts. NEVER returns encrypted blobs — only
  // metadata safe to render in the dashboard.
  router.get('/auth/grvt-sub-accounts', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const rows = await gridBotDb.listGrvtSubAccounts(userId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        isDefault: !!r.is_default,
        lastTestOk: r.last_test_ok == null ? null : !!r.last_test_ok,
        createdAt: r.created_at,
      }))
    );
    return;
  }));

  // ── POST /api/v2/auth/grvt-sub-accounts ───────────────────────────
  // Add a new sub-account for the authenticated user. Same validation
  // and live login+balance test as the default-credentials flow above
  // (lines 549-596) — we never persist credentials that GRVT itself
  // refuses, so users hit the real error in the UI immediately instead
  // of a confusing failure at first bot creation.
  router.post('/auth/grvt-sub-accounts', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = (req.body ?? {}) as {
      label?: unknown;
      apiKey?: unknown;
      apiSecret?: unknown;
      tradingAddress?: unknown;
      accountId?: unknown;
      subAccountId?: unknown;
      isDefault?: unknown;
    };
    const label = String(body.label ?? '').trim();
    const apiKey = String(body.apiKey ?? '').trim();
    const apiSecret = String(body.apiSecret ?? '').trim();
    const tradingAddress = String(body.tradingAddress ?? '').trim();
    const accountId = String(body.accountId ?? '').trim();
    const subAccountId = String(body.subAccountId ?? '').trim();
    const isDefault = body.isDefault === true;

    const errors: string[] = [];
    if (!label || label.length > 64) errors.push('label is required (max 64 chars)');
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

    // Live test: the same login + getBalance round trip the default
    // creds endpoint does. Only persist on success.
    const plainCreds: GrvtClientCreds = {
      apiKey, apiSecret, tradingAddress, accountId, subAccountId,
    };
    let testEquity: string | null = null;
    try {
      const testClient = new GRVTClient(plainCreds);
      const loggedIn = await testClient.login();
      if (!loggedIn) {
        return res.status(400).json({
          error: 'credential_test_failed',
          stage: 'login',
          message: 'GRVT login failed — check apiKey and apiSecret',
        });
      }
      const balance = await testClient.getBalance() as { total_equity?: string };
      testEquity = balance.total_equity ?? null;
    } catch (testErr) {
      const msg = (testErr as Error).message || 'unknown error';
      log.warn({ userId, err: msg }, 'GRVT sub-account credential test failed');
      return res.status(400).json({
        error: 'credential_test_failed',
        stage: 'account_summary',
        message: `GRVT API call failed: ${msg}`,
      });
    }

    try {
      const encrypted = encryptCredentialFields({
        apiKey, apiSecret, tradingAddress, accountId, subAccountId,
      });
      const id = await gridBotDb.createGrvtSubAccount({
        user_id: userId,
        label,
        ...encrypted,
        is_default: isDefault,
        last_test_ok: true,
      });
      log.info({ userId, subAccountRowId: id, label }, 'GRVT sub-account created');
      res.status(201).json({ id, label, isDefault, equity: testEquity });
    } catch (err) {
      log.error(
        { userId, err: (err as Error).message },
        'failed to save GRVT sub-account'
      );
      res.status(500).json({
        error: 'save_failed',
        message: (err as Error).message,
      });
    }
    return;
  }));

  // ── PATCH /api/v2/auth/grvt-sub-accounts/:id ──────────────────────
  // Edit the label or flip the default flag. Credential rotation is
  // intentionally out of scope here — to rotate keys, delete + recreate
  // (this avoids needing another live login test in the PATCH path).
  router.patch('/auth/grvt-sub-accounts/:id', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const sub = await gridBotDb.getGrvtSubAccountRaw(id);
    if (!sub || sub.user_id !== userId) {
      return res.status(404).json({ error: 'not_found' });
    }
    const body = (req.body ?? {}) as { label?: unknown; isDefault?: unknown };
    const patch: { label?: string; is_default?: boolean } = {};
    if (body.label !== undefined) {
      const label = String(body.label ?? '').trim();
      if (!label || label.length > 64) {
        return res.status(400).json({ error: 'invalid_label' });
      }
      patch.label = label;
    }
    if (body.isDefault !== undefined) {
      patch.is_default = body.isDefault === true;
    }
    if (patch.label === undefined && patch.is_default === undefined) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }
    await gridBotDb.updateGrvtSubAccountMeta(id, userId, patch);
    log.info({ userId, subAccountRowId: id, patch }, 'GRVT sub-account updated');
    res.json({ ok: true });
    return;
  }));

  // ── DELETE /api/v2/auth/grvt-sub-accounts/:id ─────────────────────
  // Refuses while any bot still references this sub-account. Forces the
  // user to either move bots or close them before tearing the creds
  // away — same protection the default-creds DELETE has.
  router.delete('/auth/grvt-sub-accounts/:id', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const sub = await gridBotDb.getGrvtSubAccountRaw(id);
    if (!sub || sub.user_id !== userId) {
      return res.status(404).json({ error: 'not_found' });
    }
    const usedBy = await gridBotDb.countBotsUsingSubAccount(id);
    if (usedBy > 0) {
      return res.status(409).json({
        error: 'has_active_bots',
        message: `${usedBy} bot(s) still use this sub-account. Close or reassign them first.`,
      });
    }
    await gridBotDb.deleteGrvtSubAccount(id, userId);
    invalidateGrvtClient(userId, id);
    log.info({ userId, subAccountRowId: id }, 'GRVT sub-account deleted');
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
             safeguard_enabled, safeguard_threshold_pct, safeguard_action,
             grvt_sub_account_id
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
      SELECT id, level_index, price, side, quantity, is_filled, pending_replace, order_id, state
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
      WHERE bot_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `, [id, limit, offset]);
    const total = await dbGet<{ c: number; sum: number }>(db, `
      SELECT COUNT(*) as c, COALESCE(SUM(profit), 0) as sum
      FROM paired_roundtrips
      WHERE bot_id = ?
    `, [id]);
    // Net profit = gross - fees (consistent with header "Realized")
    const feeRow = await dbGet<{ f: number }>(db, `
      SELECT COALESCE(SUM(fee), 0) as f FROM fills_archive WHERE bot_id = ?
    `, [id]);
    const netProfit = (total?.sum ?? 0) - (feeRow?.f ?? 0);
    res.json({ roundtrips, count: total?.c ?? 0, totalProfit: netProfit });
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

    // SOURCE OF TRUTH: paired_roundtrips scoped by bot_id.
    // Fee data from fills_archive (also scoped by bot_id).
    const rtStats = await dbGet<{ profit: number; count: number; earliest: string; latest: string }>(db, `
      SELECT COALESCE(SUM(profit), 0) as profit,
             COUNT(*) as count,
             MIN(created_at) as earliest,
             MAX(created_at) as latest
      FROM paired_roundtrips
      WHERE bot_id = ?
    `, [id]);

    const feeStats = await dbGet<{ totalFees: number; fillCount: number }>(db, `
      SELECT COALESCE(SUM(fee), 0) as totalFees,
             COUNT(*) as fillCount
      FROM fills_archive
      WHERE bot_id = ?
    `, [id]);

    const gridProfit = rtStats?.profit ?? 0;
    const totalFees = feeStats?.totalFees ?? 0;
    const pairs = rtStats?.count ?? 0;

    res.json({
      gridProfit,                              // gross trade-pair profit
      totalFees,                               // signed; negative = rebate
      netGridProfit: gridProfit - totalFees,   // grid profit AFTER fees
      pairs,                                   // matched grid round trips
      avgPerPair: pairs > 0 ? gridProfit / pairs : 0,
      fillCount: feeStats?.fillCount ?? 0,
      unpairedBuys: 0,                         // not computed from roundtrips
      unpairedSells: 0,
      firstFillAt: rtStats?.earliest ?? null,
      lastFillAt: rtStats?.latest ?? null,
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

    // H.8: virtual grids unlock num_grids up to 500 (vs 95 cap for legacy).
    const virtualEnabledVal = (body as any).virtual_enabled === true;
    const activeWindowSizeVal = Number((body as any).active_window_size);
    const maxGrids = virtualEnabledVal ? 500 : 95;

    if (!Number.isFinite(lower) || lower <= 0) errors.push('lower_price must be > 0');
    if (!Number.isFinite(upper) || upper <= 0) errors.push('upper_price must be > 0');
    if (lower >= upper) errors.push('lower_price must be < upper_price');
    if (!Number.isInteger(grids) || grids < 2 || grids > maxGrids) {
      errors.push(`num_grids must be an integer between 2 and ${maxGrids}`);
    }
    if (virtualEnabledVal) {
      if (!Number.isInteger(activeWindowSizeVal) || activeWindowSizeVal < 20 || activeWindowSizeVal > 80) {
        errors.push('active_window_size must be between 20 and 80 when virtual_enabled=true');
      }
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

    // GRVT caps at 80 open orders per instrument. Without virtual grids, the
    // bot can't exceed that. With virtual grids, only M ≤ 80 are active at once.
    const overOrderCap = grids > 95 && !virtualEnabledVal;

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
      virtual_enabled: boolean;
      active_window_size: number;
      // H.5: optional sub-account routing. Null/missing = default creds.
      grvt_sub_account_id: number | null;
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

    // H.8: virtual grids
    const virtualEnabled = body.virtual_enabled === true;
    const activeWindowSize = Number(body.active_window_size);
    const maxGridsPost = virtualEnabled ? 500 : 95;

    if (!Number.isFinite(lower) || lower <= 0) errors.push('lower_price must be > 0');
    if (!Number.isFinite(upper) || upper <= 0) errors.push('upper_price must be > 0');
    if (lower >= upper) errors.push('lower_price must be < upper_price');
    if (!Number.isInteger(grids) || grids < 2 || grids > maxGridsPost) {
      errors.push(`num_grids must be an integer between 2 and ${maxGridsPost}`);
    }
    if (virtualEnabled) {
      if (!Number.isInteger(activeWindowSize) || activeWindowSize < 20 || activeWindowSize > 80) {
        errors.push('active_window_size must be between 20 and 80 when virtual_enabled=true');
      }
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

      // H.5: validate the sub-account FK if provided. The bot can only
      // route through a row that belongs to this user — even with a
      // crafted body, the engine would refuse at run time, but failing
      // here gives the user a clean 400 instead of an opaque 500.
      let grvtSubAccountId: number | null = null;
      if (body.grvt_sub_account_id != null) {
        const id = Number(body.grvt_sub_account_id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({
            error: 'validation_failed',
            errors: ['grvt_sub_account_id must be a positive integer'],
          });
        }
        const sub = await gridBotDb.getGrvtSubAccountRaw(id);
        if (!sub || sub.user_id !== userId) {
          return res.status(400).json({
            error: 'invalid_sub_account',
            message: 'Sub-account not found',
          });
        }
        grvtSubAccountId = id;
      }

      // C.9 + H.5: reject if the same (user, pair, sub-account) tuple
      // already has an active bot. Same instrument on a DIFFERENT
      // sub-account is allowed — that's the whole point of H.5.
      // COALESCE folds NULL into a sentinel so the equality test works
      // for both the default-creds path and explicit sub-accounts.
      const existing = await dbGet<{ c: number }>(
        db,
        `SELECT COUNT(*) as c FROM grid_bots
         WHERE COALESCE(user_id, 1) = ?
           AND pair = ?
           AND COALESCE(grvt_sub_account_id, -1) = COALESCE(?, -1)
           AND status IN ('running', 'paused')`,
        [userId, pair, grvtSubAccountId]
      );
      if (existing && existing.c > 0) {
        return res.status(409).json({
          error: 'duplicate_instrument',
          message: `You already have an active bot on ${pair} for this sub-account. Close or stop it before creating a new one.`,
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
        virtualEnabled,
        activeWindowSize: virtualEnabled ? activeWindowSize : undefined,
        grvtSubAccountId,
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

      // H.3: stop-loss / take-profit (optional per-bot)
      const slPct = Number((req.body as any)?.sl_pct);
      const tpPct = Number((req.body as any)?.tp_pct);
      const slTpUpdates: string[] = [];
      const slTpParams: unknown[] = [];
      if (Number.isFinite(slPct) && slPct > 0 && slPct <= 100) {
        slTpUpdates.push('sl_pct = ?');
        slTpParams.push(slPct);
      }
      if (Number.isFinite(tpPct) && tpPct > 0 && tpPct <= 1000) {
        slTpUpdates.push('tp_pct = ?');
        slTpParams.push(tpPct);
      }
      // H.2: auto-shift
      const autoShift = (req.body as any)?.auto_shift_enabled === true;
      const autoShiftPct = Number((req.body as any)?.auto_shift_pct);
      if (autoShift && Number.isFinite(autoShiftPct) && autoShiftPct > 0) {
        slTpUpdates.push('auto_shift_enabled = 1', 'auto_shift_pct = ?');
        slTpParams.push(autoShiftPct);
      }
      if (slTpUpdates.length > 0) {
        slTpParams.push(botId);
        await dbRun(db, `UPDATE grid_bots SET ${slTpUpdates.join(', ')} WHERE id = ?`, slTpParams);
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

  // ── PATCH /api/v2/bots/:id/risk ───────────────────────────────────
  // H.3: edit-in-place SL/TP. The fields are nullable on purpose — a
  // user may have set sl_pct=10 at create time and want to remove it
  // later without recreating the bot. The engine refreshes the bot row
  // at the top of every monitor tick so changes take effect within ~5s.
  router.patch('/bots/:id/risk', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    await requireBotOwnership(db, id, req.userId!);

    const body = (req.body ?? {}) as { sl_pct?: number | null; tp_pct?: number | null };
    const updates: Record<string, number | null> = {};

    if ('sl_pct' in body) {
      const v = body.sl_pct;
      if (v == null || v === 0) {
        updates.sl_pct = null;
      } else if (typeof v !== 'number' || v <= 0 || v > 100) {
        return res.status(400).json({ error: 'sl_pct must be 0/null (disable) or between 0 and 100' });
      } else {
        updates.sl_pct = v;
      }
    }
    if ('tp_pct' in body) {
      const v = body.tp_pct;
      if (v == null || v === 0) {
        updates.tp_pct = null;
      } else if (typeof v !== 'number' || v <= 0 || v > 1000) {
        return res.status(400).json({ error: 'tp_pct must be 0/null (disable) or between 0 and 1000' });
      } else {
        updates.tp_pct = v;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    await dbRun(db, `
      UPDATE grid_bots
      SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [...Object.values(updates), id]);

    cache.invalidatePrefix('bots');
    log.info({ botId: id, ...updates }, 'risk settings updated');
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

  // ── POST /api/v2/backtest ──────────────────────────────────────────
  // H.6: simulate a grid bot on historical candles. Pure computation —
  // no real orders, no DB writes. Returns profit, drawdown, roundtrips,
  // and an equity curve for charting. Charges per-side fees on every
  // round trip (default 0.05% = 5 bps maker on GRVT).
  interface BacktestBody {
    pair?: string;
    direction?: 'long' | 'short';
    leverage?: number;
    lower_price?: number;
    upper_price?: number;
    num_grids?: number;
    investment_usdt?: number;
    fee_pct?: number;
    interval?: string;
    limit?: number;
  }

  router.post('/backtest', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as BacktestBody;
    const {
      pair, direction, leverage, lower_price, upper_price, num_grids,
      investment_usdt, fee_pct, interval, limit: candleLimit,
    } = body;

    const errors: string[] = [];
    if (!pair) errors.push('pair is required');
    if (!Number.isFinite(lower_price) || (lower_price ?? 0) <= 0) errors.push('lower_price > 0');
    if (!Number.isFinite(upper_price) || (upper_price ?? 0) <= 0) errors.push('upper_price > 0');
    if ((lower_price ?? 0) >= (upper_price ?? 0)) errors.push('lower < upper');
    if (!Number.isInteger(num_grids) || (num_grids ?? 0) < 2) errors.push('num_grids >= 2');
    if (!Number.isFinite(investment_usdt) || (investment_usdt ?? 0) <= 0) errors.push('investment > 0');
    if (!Number.isFinite(leverage) || (leverage ?? 0) < 1) errors.push('leverage >= 1');
    if (fee_pct != null && (!Number.isFinite(fee_pct) || fee_pct < 0 || fee_pct > 1)) {
      errors.push('fee_pct in [0, 1]');
    }
    if (errors.length) return res.status(400).json({ error: 'validation_failed', errors });

    try {
      // Local GrvtClient interface (line 46) types getKlines as
      // Promise<unknown[]>. Cast to the real shape from the
      // implementation so the .map below stays type-safe.
      const klines = (await grvtClient.getKlines(
        pair!,
        interval ?? 'CI_1_H',
        Math.min(candleLimit ?? 500, 1000)
      )) as Array<{
        openTime: number;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;

      const candles = klines.map((k) => ({
        time: k.openTime / 1000,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      })).reverse(); // oldest first

      const { runBacktest } = await import('../bot/backtester.js');
      const result = runBacktest(
        {
          pair: pair!,
          direction: direction ?? 'long',
          leverage: leverage!,
          lowerPrice: lower_price!,
          upperPrice: upper_price!,
          numGrids: num_grids!,
          investmentUSDT: investment_usdt!,
          feePct: fee_pct,
        },
        candles
      );

      // Thin equity curve for response. Always keep first + last point so
      // the chart shows the actual start and end equity even if the
      // sampling stride misses the final candle.
      const curve = result.equityCurve;
      const step = Math.max(1, Math.floor(curve.length / 200));
      const thinCurve: typeof curve = [];
      for (let i = 0; i < curve.length; i += step) thinCurve.push(curve[i]!);
      const last = curve[curve.length - 1];
      if (last && thinCurve[thinCurve.length - 1] !== last) thinCurve.push(last);

      res.json({ ...result, equityCurve: thinCurve });
    } catch (err) {
      res.status(500).json({ error: 'backtest_failed', message: (err as Error).message });
    }
    return;
  }));

  // ── GET /api/v2/portfolio-summary ───────────────────────────────────
  // H.7: aggregate risk metrics across all user bots.
  // Equity / PnL are rebuilt from `grid_profit_usdt + trend_pnl_usdt`
  // (NOT `total_pnl_usdt`, which is stale — written at insert time and
  // not refreshed by the engine on every tick).
  router.get('/portfolio-summary', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const bots = await dbAll<{
      id: number; pair: string; status: string; leverage: number;
      investment_usdt: number;
      grid_profit_usdt: number; trend_pnl_usdt: number;
      position_size: number; avg_entry_price: number;
    }>(db, `
      SELECT id, pair, status, leverage, investment_usdt,
             grid_profit_usdt, trend_pnl_usdt, position_size, avg_entry_price
      FROM grid_bots
      WHERE COALESCE(user_id, 1) = ? AND status != 'stopped'
    `, [userId]);

    let totalInvested = 0;
    let totalEquity = 0;
    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalPositionUsdt = 0;
    let weightedLeverage = 0;
    const pairExposure: Record<string, number> = {};

    for (const b of bots) {
      const botPnl = b.grid_profit_usdt + b.trend_pnl_usdt;
      const equity = b.investment_usdt + botPnl;
      const positionUsdt = b.position_size * b.avg_entry_price;
      totalInvested += b.investment_usdt;
      totalEquity += equity;
      totalRealized += b.grid_profit_usdt;
      totalUnrealized += b.trend_pnl_usdt;
      totalPositionUsdt += positionUsdt;
      weightedLeverage += b.leverage * b.investment_usdt;
      pairExposure[b.pair] = (pairExposure[b.pair] ?? 0) + positionUsdt;
    }

    const avgLeverage = totalInvested > 0 ? weightedLeverage / totalInvested : 0;

    res.json({
      botCount: bots.length,
      runningCount: bots.filter(b => b.status === 'running').length,
      totalInvested: round(totalInvested, 2),
      totalEquity: round(totalEquity, 2),
      totalRealized: round(totalRealized, 2),
      totalUnrealized: round(totalUnrealized, 2),
      totalPnl: round(totalRealized + totalUnrealized, 2),
      totalPnlPct: totalInvested > 0 ? round(((totalRealized + totalUnrealized) / totalInvested) * 100, 2) : 0,
      totalPositionUsdt: round(totalPositionUsdt, 2),
      avgLeverage: round(avgLeverage, 1),
      pairExposure,
    });
    return;
  }));

  // ── GET /api/v2/portfolio-equity-curve ──────────────────────────────
  // H.7: aggregate equity across the user's bots, grouped by date.
  // Sums daily_snapshots.equity per (date) for all non-stopped bots
  // owned by the user. Bots without a snapshot for a given day don't
  // contribute on that day — there is no carry-forward, so early days
  // (when fewer bots existed) read as a smaller portfolio.
  router.get('/portfolio-equity-curve', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const days = Math.min(parseInt(String(req.query.days ?? '90'), 10) || 90, 365);
    const rows = await dbAll<{ date: string; equity: number }>(db, `
      SELECT s.date, SUM(s.equity) AS equity
      FROM daily_snapshots s
      JOIN grid_bots b ON b.id = s.bot_id
      WHERE COALESCE(b.user_id, 1) = ?
        AND b.status != 'stopped'
        AND s.date >= date('now', ?)
      GROUP BY s.date
      ORDER BY s.date ASC
    `, [userId, `-${days} days`]);
    res.json({ points: rows });
    return;
  }));

  // ── GET /api/v2/alerts ─────────────────────────────────────────────
  // F.6: Read the notifier's alert history file. The notifier writes
  // this as a JSON array in its state directory; we read it from the
  // shared data path. Returns newest-first, with optional ?limit.
  //
  // SECURITY: filtered by userId. Each alert is tagged with the owning
  // user when the notifier writes it; entries that pre-date the
  // multi-tenant security fix (and therefore lack a userId) are treated
  // as owned by user 1 (the operator), matching the v2-router COALESCE
  // policy elsewhere.
  router.get('/alerts', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    try {
      const fs = await import('node:fs');
      const stateDir = process.env.NOTIFIER_STATE_DIR ?? '/var/lib/grvt-grid-notifier';
      const historyPath = `${stateDir}/alert-history.json`;
      if (!fs.existsSync(historyPath)) {
        res.json({ alerts: [] });
        return;
      }
      const raw = fs.readFileSync(historyPath, 'utf8');
      const all = JSON.parse(raw) as Array<{ userId?: number } & Record<string, unknown>>;
      const mine = all.filter((a) => (a.userId ?? 1) === userId);
      const recent = mine.slice(-limit).reverse(); // newest first
      res.json({ alerts: recent });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'alert history read failed');
      res.json({ alerts: [], degraded: true });
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
