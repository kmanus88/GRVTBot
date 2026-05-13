// D.2 — REST API endpoint tests
// Tests the v2 router handlers for Phase C features: health check (C.6),
// duplicate instrument guard (C.9), safeguard field validation (C.4),
// pagination params (C.7), and credential format validation (C.2).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createV2Router, type V2RouterDeps } from '../src/server/v2-router.js';

// ── Mock deps ────────────────────────────────────────────────────────
// The router takes injected deps — we provide fakes that return
// controlled data so we can test handler logic in isolation.

// Minimal in-memory "database" using callbacks matching sqlite3 shape
function makeMockDb() {
  const rows: Record<string, any[]> = {};
  return {
    all(sql: string, params: any[], cb: (err: Error | null, rows: any[]) => void) {
      // C.9: duplicate check
      if (sql.includes('COUNT(*)') && sql.includes('grid_bots') && sql.includes('status')) {
        const pair = params[1];
        const active = (rows['bots'] ?? []).filter(
          (b: any) => b.pair === pair && (b.status === 'running' || b.status === 'paused')
        );
        cb(null, [{ c: active.length }]);
        return;
      }
      // GET /bots
      if (sql.includes('SELECT') && sql.includes('grid_bots') && sql.includes('ORDER BY')) {
        cb(null, rows['bots'] ?? []);
        return;
      }
      cb(null, []);
    },
    get(sql: string, params: any[], cb: (err: Error | null, row: any) => void) {
      // C.9: duplicate instrument check (has "pair = ?" in the SQL)
      if (sql.includes('COUNT(*)') && sql.includes('pair')) {
        const pair = params[1]; // [userId, pair]
        const active = (rows['bots'] ?? []).filter(
          (b: any) => b.pair === pair && (b.status === 'running' || b.status === 'paused')
        );
        cb(null, { c: active.length });
        return;
      }
      // Health: running bots count (no "pair" in the SQL)
      if (sql.includes('COUNT(*)') && sql.includes('running')) {
        const running = (rows['bots'] ?? []).filter((b: any) => b.status === 'running');
        cb(null, { c: running.length });
        return;
      }
      // Bot ownership check
      if (sql.includes('SELECT') && sql.includes('grid_bots') && sql.includes('id = ?')) {
        const id = params[0];
        const bot = (rows['bots'] ?? []).find((b: any) => b.id === id);
        cb(null, bot);
        return;
      }
      cb(null, undefined);
    },
    run(sql: string, params: any[], cb: (this: { changes: number; lastID: number }, err: Error | null) => void) {
      // INSERT/UPDATE: just succeed
      cb.call({ changes: 1, lastID: 99 }, null);
    },
    _rows: rows,
    _addBot(bot: any) {
      if (!rows['bots']) rows['bots'] = [];
      rows['bots'].push(bot);
    },
  };
}

function makeMockGrvtClient() {
  return {
    getInstruments: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ total_equity: '10000', available_balance: '5000' }),
    getTicker: vi.fn().mockResolvedValue({ last_price: '2100' }),
    getPosition: vi.fn().mockResolvedValue(null),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getKlines: vi.fn().mockResolvedValue([]),
    getFillHistory: vi.fn().mockResolvedValue([]),
  };
}

function makeMockEngineOps() {
  return {
    createBot: vi.fn().mockResolvedValue(42),
    startBot: vi.fn().mockResolvedValue(undefined),
    pauseBot: vi.fn().mockResolvedValue(undefined),
    closeBot: vi.fn().mockResolvedValue(undefined),
    updateBotRange: vi.fn().mockResolvedValue(undefined),
    previewBotRangeUpdate: vi.fn().mockResolvedValue({}),
    rebindGrvtClient: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockGridBotDb() {
  return {
    upsertGrvtCredentials: vi.fn().mockResolvedValue(undefined),
    getGrvtCredentialsRaw: vi.fn().mockResolvedValue(null),
    deleteGrvtCredentials: vi.fn().mockResolvedValue(undefined),
    countActiveBotsForUser: vi.fn().mockResolvedValue(0),
    insertTermsAcceptance: vi.fn().mockResolvedValue(undefined),
    touchGrvtCredentialsLastUsed: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Test app factory ─────────────────────────────────────────────────

const API_KEY = 'test-api-key-32-chars-long-xxxx';

function createTestApp() {
  const db = makeMockDb();
  const grvtClient = makeMockGrvtClient();
  const engineOps = makeMockEngineOps();
  const gridBotDb = makeMockGridBotDb();

  const router = createV2Router({
    db: db as any,
    gridBotDb: gridBotDb as any,
    grvtClient: grvtClient as any,
    engineOps,
    apiKey: API_KEY,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v2', router);

  return { app, db, grvtClient, engineOps, gridBotDb };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/v2/health (C.6)', () => {
  it('returns ok when DB and GRVT are reachable', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get('/api/v2/health')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.db.ok).toBe(true);
    expect(res.body.checks.grvt.ok).toBe(true);
    expect(res.body.uptime).toBeTypeOf('number');
    expect(res.body.memory.rss).toBeTypeOf('number');
  });

  it('returns degraded when GRVT is down', async () => {
    const { app, grvtClient } = createTestApp();
    grvtClient.getTicker.mockRejectedValue(new Error('GRVT unreachable'));

    const res = await request(app)
      .get('/api/v2/health')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.db.ok).toBe(true);
    expect(res.body.checks.grvt.ok).toBe(false);
    expect(res.body.checks.grvt.error).toContain('GRVT unreachable');
  });
});

describe('POST /api/v2/bots — C.9 duplicate instrument guard', () => {
  it('rejects 409 when user already has an active bot on the same pair', async () => {
    const { app, db } = createTestApp();
    db._addBot({ id: 1, user_id: 1, pair: 'ETH_USDT_Perp', status: 'running' });

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_instrument');
  });

  it('allows creation on a different pair', async () => {
    const { app, db } = createTestApp();
    db._addBot({ id: 1, user_id: 1, pair: 'ETH_USDT_Perp', status: 'running' });

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'BTC_USDT_Perp',
        direction: 'long',
        lower_price: 60000,
        upper_price: 80000,
        num_grids: 10,
        investment_usdt: 1000,
        leverage: 2,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
  });

  it('allows creation when existing bot is stopped', async () => {
    const { app, db } = createTestApp();
    db._addBot({ id: 1, user_id: 1, pair: 'ETH_USDT_Perp', status: 'stopped' });

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
      });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/v2/bots — C.4 safeguard validation', () => {
  it('accepts bot with valid safeguard fields', async () => {
    const { app, engineOps } = createTestApp();

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
        safeguard_enabled: true,
        safeguard_threshold_pct: 10,
        safeguard_action: 'pause',
      });

    expect(res.status).toBe(201);
  });

  it('rejects safeguard without threshold when enabled', async () => {
    const { app } = createTestApp();

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
        safeguard_enabled: true,
        // missing threshold and action
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('rejects safeguard with invalid action', async () => {
    const { app } = createTestApp();

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
        safeguard_enabled: true,
        safeguard_threshold_pct: 10,
        safeguard_action: 'invalid_action',
      });

    expect(res.status).toBe(400);
  });

  it('accepts bot without safeguard (default off)', async () => {
    const { app } = createTestApp();

    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        lower_price: 1800,
        upper_price: 2400,
        num_grids: 10,
        investment_usdt: 500,
        leverage: 2,
      });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/v2/bots — basic validation', () => {
  it('rejects missing pair', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({ direction: 'long', lower_price: 1800, upper_price: 2400, num_grids: 10, investment_usdt: 500, leverage: 2 });

    expect(res.status).toBe(400);
  });

  it('rejects lower >= upper', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({ pair: 'ETH_USDT_Perp', direction: 'long', lower_price: 2400, upper_price: 1800, num_grids: 10, investment_usdt: 500, leverage: 2 });

    expect(res.status).toBe(400);
  });

  it('rejects grids > 95', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/bots')
      .set('X-Api-Key', API_KEY)
      .send({ pair: 'ETH_USDT_Perp', direction: 'long', lower_price: 1800, upper_price: 2400, num_grids: 100, investment_usdt: 500, leverage: 2 });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v2/auth/grvt-credentials — C.2 format validation', () => {
  it('rejects missing apiKey', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/auth/grvt-credentials')
      .set('X-Api-Key', API_KEY)
      .send({
        apiSecret: '0x' + 'a'.repeat(64),
        tradingAddress: '0x' + 'b'.repeat(40),
        accountId: '123',
        subAccountId: '456',
      });

    expect(res.status).toBe(400);
    expect(res.body.errors).toContain('apiKey is required');
  });

  it('rejects invalid apiSecret format (not 0x-prefixed 32-byte hex)', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/auth/grvt-credentials')
      .set('X-Api-Key', API_KEY)
      .send({
        apiKey: 'some-key',
        apiSecret: 'not-hex',
        tradingAddress: '0x' + 'b'.repeat(40),
        accountId: '123',
        subAccountId: '456',
      });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: string) => e.includes('apiSecret'))).toBe(true);
  });

  it('rejects invalid tradingAddress (not 0x + 40 hex)', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post('/api/v2/auth/grvt-credentials')
      .set('X-Api-Key', API_KEY)
      .send({
        apiKey: 'some-key',
        apiSecret: '0x' + 'a'.repeat(64),
        tradingAddress: 'bad-address',
        accountId: '123',
        subAccountId: '456',
      });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: string) => e.includes('tradingAddress'))).toBe(true);
  });
});

describe('Auth middleware', () => {
  it('rejects requests without auth header', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/v2/health');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('accepts valid X-Api-Key', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get('/api/v2/health')
      .set('X-Api-Key', API_KEY);

    expect(res.status).toBe(200);
  });
});

// ── SECURITY: pre-auth Prometheus endpoint (C-4) ────────────────────
// /api/v2/metrics deliberately sits BEFORE the JWT auth middleware so
// Prometheus scrapers don't need a user JWT. The security audit found
// this exposed per-bot equity/PnL/position labels to anyone who could
// reach the port. The fix gates it on either METRICS_TOKEN or
// localhost-origin requests; everything else must 401.
describe('GET /api/v2/metrics — C-4 gate', () => {
  const PREV_TOKEN = process.env.METRICS_TOKEN;
  beforeAll(() => { delete process.env.METRICS_TOKEN; });
  afterAll(() => {
    if (PREV_TOKEN === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = PREV_TOKEN;
  });

  it('rejects external requests when METRICS_TOKEN is unset and request is not from localhost', async () => {
    delete process.env.METRICS_TOKEN;
    const { app } = createTestApp();
    // supertest's req.ip resolves to ::ffff:127.0.0.1 (mapped IPv4) by
    // default. Spoofing X-Forwarded-For doesn't help — the gate reads
    // req.socket.remoteAddress / req.ip directly. To exercise the
    // non-localhost path we set req.ip via trust proxy.
    app.set('trust proxy', true);
    const res = await request(app)
      .get('/api/v2/metrics')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(401);
    expect(res.body.hint).toContain('METRICS_TOKEN');
  });

  it('allows localhost requests when no token is configured', async () => {
    delete process.env.METRICS_TOKEN;
    const { app } = createTestApp();
    const res = await request(app).get('/api/v2/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('grvt_bot_count');
  });

  it('requires a valid token when METRICS_TOKEN is configured', async () => {
    process.env.METRICS_TOKEN = 'super-secret-token-32-chars-min!!';
    const { app } = createTestApp();
    const reject = await request(app).get('/api/v2/metrics');
    expect(reject.status).toBe(401);

    const wrongTok = await request(app)
      .get('/api/v2/metrics')
      .set('Authorization', 'Bearer wrong-token');
    expect(wrongTok.status).toBe(401);

    const ok = await request(app)
      .get('/api/v2/metrics')
      .set('Authorization', 'Bearer super-secret-token-32-chars-min!!');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('grvt_bot_count');
  });

  it('accepts token via ?token= query param too', async () => {
    process.env.METRICS_TOKEN = 'super-secret-token-32-chars-min!!';
    const { app } = createTestApp();
    const ok = await request(app).get(
      '/api/v2/metrics?token=super-secret-token-32-chars-min!!'
    );
    expect(ok.status).toBe(200);
  });
});

// ── SECURITY: password reset must not trust Host header (C-3) ────────
// Pre-fix, if APP_BASE_URL was unset, the handler built the reset URL
// from req.protocol + req.get('host'), letting an attacker host-spoof
// the email link to a phishing domain. The fix refuses to derive from
// Host and falls back to the enumeration-safe 200 response.
describe('POST /api/v2/auth/forgot-password — C-3 Host header', () => {
  const PREV = process.env.APP_BASE_URL;
  beforeAll(() => { delete process.env.APP_BASE_URL; });
  afterAll(() => {
    if (PREV === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = PREV;
  });

  it('returns 200 silently when APP_BASE_URL is unset and never uses Host header', async () => {
    delete process.env.APP_BASE_URL;
    const { app, gridBotDb } = createTestApp();
    // Make the user lookup return a "real" user so the handler takes
    // the configured-but-cannot-build-URL branch (not the unknown-
    // email branch).
    (gridBotDb as any).getUserByEmail = vi.fn().mockResolvedValue({
      id: 1, email: 'victim@example.com', password_hash: 'x',
    });
    (gridBotDb as any).invalidateOpenPasswordResetTokensForUser = vi.fn().mockResolvedValue(undefined);
    (gridBotDb as any).insertPasswordResetToken = vi.fn().mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/v2/auth/forgot-password')
      .set('Host', 'evil.attacker.example.com')
      .send({ email: 'victim@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Most important assertion: we never wrote a reset token, because
    // we can't construct a usable URL. (Pre-fix this would have INSERTed
    // a token AND emailed it pointing at evil.attacker.example.com.)
    expect((gridBotDb as any).insertPasswordResetToken).not.toHaveBeenCalled();
  });
});
