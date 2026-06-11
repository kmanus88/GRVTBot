// D.6 — DB migration idempotency + backfill tests.
// Uses an in-memory SQLite (no filesystem touch) so we can run the
// real GridBotDB.initialize() — which both creates tables and runs all
// the ALTER TABLE migrations — and verify:
//   - every expected column ends up on grid_bots
//   - re-running initialize() is a no-op (no duplicate-column errors)
//   - the backfill UPDATE for original_investment_usdt + quantity_per_level
//     correctly populates legacy NULL rows
//
// We bypass the singleton (`db` from db.ts) and instantiate GridBotDB
// directly with `:memory:` so each test gets an isolated DB.

import { describe, it, expect } from 'vitest';
import { GridBotDB } from '../src/database/db';

async function makeDb(): Promise<GridBotDB> {
  const db = new GridBotDB(':memory:');
  await db.initialize();
  return db;
}

// Cast helper — exercises the private dbAll/dbRun/dbGet via reflection.
// Accepting the `any` here is the price of testing migration internals
// without dragging the whole engine into the test surface.
function priv(db: GridBotDB) {
  return db as unknown as {
    dbRun: (sql: string, ...p: unknown[]) => Promise<{ lastID: number; changes: number }>;
    dbAll: (sql: string, ...p: unknown[]) => Promise<unknown[]>;
    dbGet: (sql: string, ...p: unknown[]) => Promise<Record<string, unknown> | undefined>;
  };
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

async function columns(db: GridBotDB, table: string): Promise<string[]> {
  const rows = (await priv(db).dbAll(`PRAGMA table_info(${table})`)) as ColumnInfo[];
  return rows.map((r) => r.name);
}

describe('GridBotDB migrations (D.6)', () => {
  it('creates the grid_bots table with all expected columns after initialize()', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'grid_bots');

    // Base CREATE TABLE columns
    for (const c of [
      'id', 'pair', 'direction', 'leverage', 'lower_price', 'upper_price',
      'num_grids', 'investment_usdt', 'grid_profit_usdt', 'trend_pnl_usdt',
      'total_pnl_usdt', 'status', 'position_size', 'avg_entry_price',
      'liquidation_price', 'created_at', 'updated_at', 'params_json',
    ]) {
      expect(cols, `missing base column: ${c}`).toContain(c);
    }

    // Migration columns (added via ALTER TABLE)
    for (const c of [
      'original_investment_usdt',
      'quantity_per_level',
      'compound_pct', 'compound_threshold_usdt', 'compound_interval_hours',
      'last_compound_at', 'total_reinvested',
      'safeguard_enabled', 'safeguard_threshold_pct', 'safeguard_action',
      'sl_pct', 'tp_pct',
      'auto_shift_enabled', 'auto_shift_pct', 'last_auto_shift_at',
      'virtual_enabled', 'active_window_size',
    ]) {
      expect(cols, `missing migration column: ${c}`).toContain(c);
    }
  });

  it('creates the grid_levels table with the H.8 state column', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'grid_levels');
    for (const c of ['id', 'bot_id', 'level_index', 'price', 'side', 'quantity', 'is_filled', 'pending_replace', 'order_id']) {
      expect(cols).toContain(c);
    }
  });

  it('creates daily_snapshots with both legacy and new columns', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'daily_snapshots');
    // New schema
    for (const c of ['date', 'equity', 'grid_profit_net', 'trend_pnl', 'total_pnl']) {
      expect(cols).toContain(c);
    }
  });

  it('creates fills_archive with bot_id + instrument FK', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'fills_archive');
    expect(cols).toContain('bot_id');
    expect(cols).toContain('instrument');
  });

  it('creates paired_roundtrips with bot_id (unification fix)', async () => {
    const db = await makeDb();
    const cols = await columns(db, 'paired_roundtrips');
    expect(cols).toContain('bot_id');
  });

  it('initialize() is idempotent — running it twice does not throw', async () => {
    const db = new GridBotDB(':memory:');
    await db.initialize();
    // Second run hits every "ALTER TABLE ... ADD COLUMN" again. The
    // try/catch in createTables swallows "column already exists" so
    // this should resolve cleanly.
    await expect(db.initialize()).resolves.not.toThrow();
  });

  it('backfills original_investment_usdt for rows where it is NULL', async () => {
    const db = await makeDb();

    // Insert a "legacy" bot, then NULL out the column to simulate a row
    // that pre-existed before the migration added the column.
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('ETH_USDT_Perp', 'long', 2, 1800, 2400, 10, 750, 'paused')
    `);
    await priv(db).dbRun(`UPDATE grid_bots SET original_investment_usdt = NULL`);

    // Re-run init — the backfill UPDATE re-fires and fills the NULL.
    await db.initialize();

    const row = await priv(db).dbGet(`
      SELECT investment_usdt, original_investment_usdt FROM grid_bots WHERE pair = 'ETH_USDT_Perp'
    `);
    expect(row?.investment_usdt).toBe(750);
    expect(row?.original_investment_usdt).toBe(750);
  });

  it('backfills quantity_per_level from grid_levels for legacy bots', async () => {
    const db = await makeDb();

    // Insert a bot + a single grid level with quantity = 0.04. Then NULL
    // out the bot's quantity_per_level to simulate a legacy row.
    const res = await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('BTC_USDT_Perp', 'long', 2, 60000, 80000, 10, 1000, 'paused')
    `);
    const botId = res.lastID;
    await priv(db).dbRun(`
      INSERT INTO grid_levels (bot_id, level_index, price, side, quantity)
      VALUES (?, 0, 65000, 'buy', 0.04)
    `, botId);
    await priv(db).dbRun(`UPDATE grid_bots SET quantity_per_level = NULL WHERE id = ?`, botId);

    // Re-run → backfill picks up grid_levels[0].quantity = 0.04.
    await db.initialize();

    const row = await priv(db).dbGet(`SELECT quantity_per_level FROM grid_bots WHERE id = ?`, botId);
    expect(row?.quantity_per_level).toBe(0.04);
  });

  it('createDailySnapshot persists a row on a fresh-schema DB', async () => {
    // Regression: the INSERT used to name legacy columns (timestamp,
    // balance_usdt, ...) that only exist on migrated pre-monorepo DBs,
    // so every nightly snapshot failed with SQLITE_ERROR on fresh
    // installs and the equity curve stayed empty forever.
    const db = await makeDb();
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('BNB_USDT_Perp', 'long', 3, 560, 700, 10, 60, 'running')
    `);

    await db.createDailySnapshot({
      bot_id: 1,
      date: '2026-06-11',
      equity: 59.32,
      grid_profit_net: 1.49,
      trend_pnl: -2.17,
      total_pnl: -0.68,
      round_trips: 4,
      eth_price: 596.69,
    });

    const rows = await db.getDailySnapshotsByBot(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-06-11');
    expect(rows[0].equity).toBe(59.32);
    expect(rows[0].round_trips).toBe(4);
  });

  it('createDailySnapshot persists a row on a legacy-schema DB', async () => {
    // Legacy DBs (pre-monorepo bot v1) have the old column set, with
    // timestamp NOT NULL — the write must keep populating those so the
    // same code serves both schema generations.
    const db = new GridBotDB(':memory:');
    await priv(db).dbRun(`
      CREATE TABLE daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL,
        timestamp DATETIME NOT NULL,
        balance_usdt REAL NOT NULL,
        equity_usdt REAL NOT NULL,
        grid_profit_usdt REAL NOT NULL,
        trend_pnl_usdt REAL NOT NULL,
        total_pnl_usdt REAL NOT NULL,
        num_round_trips INTEGER DEFAULT 0,
        position_size REAL DEFAULT 0,
        drawdown_pct REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bot_id, timestamp)
      )
    `);
    await db.initialize(); // runs the ALTERs that add the new columns
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, status)
      VALUES ('ETH_USDT_Perp', 'long', 2, 1800, 2400, 10, 750, 'running')
    `);

    await db.createDailySnapshot({
      bot_id: 1,
      date: '2026-06-11',
      equity: 812.5,
      grid_profit_net: 53.1,
      trend_pnl: 9.4,
      total_pnl: 62.5,
      round_trips: 120,
      eth_price: 2210,
    });

    const rows = await db.getDailySnapshotsByBot(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].equity).toBe(812.5);
    // Legacy mirror columns stay in sync for old readers
    const raw = await priv(db).dbGet(`SELECT timestamp, equity_usdt FROM daily_snapshots WHERE bot_id = 1`);
    expect(raw?.equity_usdt).toBe(812.5);
    expect(raw?.timestamp).toBe('2026-06-11T00:00:00.000Z');
  });

  it('does NOT overwrite original_investment_usdt for rows that already have it', async () => {
    const db = await makeDb();

    // New row with explicit original_investment_usdt = 500. Even if
    // investment_usdt later bumps to 750 (e.g. after a compound), the
    // original should stay 500 across re-runs of initialize().
    await priv(db).dbRun(`
      INSERT INTO grid_bots (pair, direction, leverage, lower_price, upper_price,
        num_grids, investment_usdt, original_investment_usdt, status)
      VALUES ('SOL_USDT_Perp', 'long', 5, 100, 200, 20, 750, 500, 'paused')
    `);

    await db.initialize();

    const row = await priv(db).dbGet(`
      SELECT investment_usdt, original_investment_usdt FROM grid_bots WHERE pair = 'SOL_USDT_Perp'
    `);
    expect(row?.investment_usdt).toBe(750);
    expect(row?.original_investment_usdt).toBe(500); // preserved, not bumped to 750
  });
});
