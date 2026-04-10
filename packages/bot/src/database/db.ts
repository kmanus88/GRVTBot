// Database SQLite - Fase 3
// WAL mode + tablas: bots, grid_levels, orders, trades, funding_history
// Según specs de grvt-grid-bot-specs.md

import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

// Configurar SQLite para verbose logging en desarrollo
const Database = process.env.NODE_ENV === 'production' ? sqlite3.Database : sqlite3.verbose().Database;

export interface GridBot {
  id: number;
  // Multi-tenant: which user owns this bot. Required for all new
  // bots; nullable on the type for backward compat with rows from
  // before the migration (those get backfilled by ownerBootstrap).
  user_id?: number;
  pair: string;
  direction: 'long' | 'short';
  leverage: number;
  lower_price: number;
  upper_price: number;
  num_grids: number;
  investment_usdt: number;
  grid_profit_usdt: number;
  trend_pnl_usdt: number;
  total_pnl_usdt: number;
  status: 'paused' | 'running' | 'stopped';
  position_size: number;
  avg_entry_price: number;
  liquidation_price: number;
  created_at: string;
  updated_at: string;
  params_json: string; // JSON con parámetros adicionales
  grid_profit_seed?: number;
  grid_profit_seed_timestamp?: string;
  total_reinvested?: number;
  original_investment_usdt?: number;
  // Set at creation, immutable. Source of truth for per-level order
  // size — read by getFixedQty(), updateBotRange(), etc. Replaces
  // the recompute-from-investment_usdt formula that drifted under
  // compound rebalances.
  quantity_per_level?: number;
  // Compound rebalance settings (0 = disabled)
  compound_pct?: number;
  compound_threshold_usdt?: number;
  compound_interval_hours?: number;
  last_compound_at?: string;
}

export interface GridLevel {
  id: number;
  bot_id: number;
  level_index: number;
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
  is_filled: boolean;
  pending_replace?: boolean;
  order_id?: string;
  filled_at?: string;
  created_at: string;
}

export interface OrderRecord {
  id: number;
  bot_id: number;
  order_id: string;
  instrument: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  quantity: number;
  price: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  grid_level_id?: number;
  metadata?: string;
  created_at: string;
  updated_at: string;
}

export interface TradeRecord {
  id: number;
  bot_id: number;
  order_id: string;
  fill_id: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  fee_currency: string;
  pnl_usdt?: number;
  round_trip_profit?: number;
  created_at: string;
}

export interface FundingRecord {
  id: number;
  bot_id: number;
  instrument: string;
  funding_rate: number;
  payment_usdt: number;
  position_size: number;
  funding_time: string;
  created_at: string;
}

export interface DailySnapshot {
  id: number;
  bot_id: number;
  date: string; // YYYY-MM-DD
  equity: number;
  grid_profit_net: number;
  trend_pnl: number;
  total_pnl: number;
  round_trips: number;
  eth_price: number | null;
  created_at: string;
}

/**
 * Database Manager con SQLite + WAL mode
 */
export class GridBotDB {
  private db: sqlite3.Database;
  private dbPath: string;

  // Métodos promisificados
  private dbRun: (sql: string, ...params: any[]) => Promise<sqlite3.RunResult>;
  private dbGet: (sql: string, ...params: any[]) => Promise<any>;
  private dbAll: (sql: string, ...params: any[]) => Promise<any[]>;

  constructor(dbPath?: string) {
    // Usar directorio de datos del proyecto
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = dbPath || path.join(dataDir, 'grid_bot.db');
    
    // Abrir database
    this.db = new Database(this.dbPath, (err) => {
      if (err) {
        console.error('❌ Error abriendo SQLite database:', err);
        throw err;
      }
      console.log(`📊 SQLite database: ${this.dbPath}`);
    });

    // Promisificar métodos — sqlite3 db.run necesita wrapper especial para lastID
    this.dbRun = (sql: string, ...params: any[]): Promise<sqlite3.RunResult> => {
      return new Promise((resolve, reject) => {
        this.db.run(sql, ...params, function(this: sqlite3.RunResult, err: Error | null) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes } as sqlite3.RunResult);
        });
      });
    };
    this.dbGet = promisify(this.db.get.bind(this.db));
    this.dbAll = promisify(this.db.all.bind(this.db));
  }

  /**
   * Inicializar database: WAL mode + crear tablas
   */
  async initialize(): Promise<void> {
    try {
      // Configurar WAL mode (Write-Ahead Logging)
      await this.dbRun('PRAGMA journal_mode = WAL');
      await this.dbRun('PRAGMA synchronous = NORMAL');
      await this.dbRun('PRAGMA cache_size = 1000');
      await this.dbRun('PRAGMA temp_store = MEMORY');
      
      console.log('⚡ SQLite en WAL mode');

      // Crear tablas
      await this.createTables();
      
      console.log('✅ Database inicializada');
      
    } catch (error) {
      console.error('❌ Error inicializando database:', error);
      throw error;
    }
  }

  /**
   * Crear todas las tablas
   */
  private async createTables(): Promise<void> {
    // Tabla: grid_bots
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS grid_bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
        leverage INTEGER NOT NULL,
        lower_price REAL NOT NULL,
        upper_price REAL NOT NULL,
        num_grids INTEGER NOT NULL,
        investment_usdt REAL NOT NULL,
        grid_profit_usdt REAL DEFAULT 0,
        trend_pnl_usdt REAL DEFAULT 0,
        total_pnl_usdt REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('paused', 'running', 'stopped')),
        position_size REAL DEFAULT 0,
        avg_entry_price REAL DEFAULT 0,
        liquidation_price REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        params_json TEXT DEFAULT '{}'
      )
    `);

    // Tabla: grid_levels
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS grid_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        level_index INTEGER NOT NULL,
        price REAL NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity REAL NOT NULL,
        is_filled BOOLEAN DEFAULT 0,
        pending_replace BOOLEAN DEFAULT 0,
        order_id TEXT,
        filled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bot_id, level_index)
      )
    `);

    // Agregar columna pending_replace si no existe (migration)
    try {
      await this.dbRun(`ALTER TABLE grid_levels ADD COLUMN pending_replace BOOLEAN DEFAULT 0`);
      console.log('✅ Columna pending_replace agregada a grid_levels');
    } catch (e) {
      // Columna ya existe, ignorar error
    }

    // Migration: original_investment_usdt — the cash deposit at bot
    // creation, immutable. Required because investment_usdt gets bumped
    // by compound rebalances AND by external margin transfers, so it
    // no longer reflects the original deposit. New bots set this on
    // INSERT; for legacy bots we backfill = current investment_usdt
    // (best guess; the user can manually correct individual rows).
    try {
      await this.dbRun(`ALTER TABLE grid_bots ADD COLUMN original_investment_usdt REAL`);
      console.log('✅ Columna original_investment_usdt agregada a grid_bots');
    } catch (e) {
      // Columna ya existe, ignorar
    }
    // Backfill NULL rows so the column has data for existing bots.
    await this.dbRun(`
      UPDATE grid_bots
      SET original_investment_usdt = investment_usdt
      WHERE original_investment_usdt IS NULL
    `);

    // Migration: quantity_per_level — the IMMUTABLE per-grid order size,
    // set at bot creation. Critical fix for the "qty drift" bug:
    //
    //   Previously, getFixedQty() recomputed qty on every call from
    //   investment_usdt * leverage * 0.75 / num_grids / midPrice.
    //   When compound bumped investment_usdt mid-life, the formula
    //   produced a bigger qty for new orders → buys placed at qty=0.04
    //   would later get matched against sells placed at qty=0.05, with
    //   the residual 0.01 polluting the position permanently. Bot 42
    //   accumulated months of drift this way.
    //
    // Fix: store the qty at bot creation and read it from here forever.
    // The only legitimate way to change it is a deliberate "rebalance"
    // operation that ALSO adjusts the position to match — never via a
    // silent recompute on each monitor tick.
    try {
      await this.dbRun(`ALTER TABLE grid_bots ADD COLUMN quantity_per_level REAL`);
      console.log('✅ Columna quantity_per_level agregada a grid_bots');
    } catch (e) { /* already exists */ }
    // Backfill from existing grid_levels[0].quantity for legacy bots —
    // this is the qty the bot has been using lately, so it's the
    // pragmatic "current truth". Bot 42 will get 0.05.
    await this.dbRun(`
      UPDATE grid_bots
      SET quantity_per_level = (
        SELECT quantity FROM grid_levels
        WHERE grid_levels.bot_id = grid_bots.id
        LIMIT 1
      )
      WHERE quantity_per_level IS NULL
    `);

    // Tabla: bot_cash_movements — explicit ledger for every cash flow
    // touching a bot's notional. Each row records WHY investment_usdt
    // changed: 'compound' when the engine reinvested grid profit,
    // 'deposit' when external margin was transferred in, 'withdrawal'
    // when funds were pulled out. New bots populate this from day 1
    // so we can always reconstruct: original_investment + sum(deposits)
    // + sum(compounds) - sum(withdrawals) = current_notional, with
    // every component accounted for.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS bot_cash_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('compound', 'deposit', 'withdrawal', 'initial')),
        amount_usdt REAL NOT NULL,
        notes TEXT,
        occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.dbRun(`
      CREATE INDEX IF NOT EXISTS idx_cash_movements_bot
        ON bot_cash_movements(bot_id, occurred_at)
    `);

    // Tabla: orders
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        order_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        type TEXT NOT NULL CHECK (type IN ('limit', 'market')),
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
        grid_level_id INTEGER REFERENCES grid_levels(id),
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(order_id)
      )
    `);

    // Tabla: trades
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        order_id TEXT NOT NULL,
        fill_id TEXT NOT NULL UNIQUE,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        fee REAL NOT NULL,
        fee_currency TEXT DEFAULT 'USDT',
        pnl_usdt REAL,
        round_trip_profit REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla: funding_history
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS funding_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        funding_rate REAL NOT NULL,
        payment_usdt REAL NOT NULL,
        position_size REAL NOT NULL,
        funding_time DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL REFERENCES grid_bots(id) ON DELETE CASCADE,
        date TEXT NOT NULL, -- YYYY-MM-DD
        equity REAL NOT NULL,
        grid_profit_net REAL NOT NULL,
        trend_pnl REAL NOT NULL,
        total_pnl REAL NOT NULL,
        round_trips INTEGER DEFAULT 0,
        eth_price REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bot_id, date)
      )
    `);

    // Tabla: fills_archive — every GRVT fill we've ever observed for this
    // sub-account, attributed to a bot via (bot_id, instrument).
    // Originally created ad-hoc by an emergency script (no bot_id, global).
    // Migration below adds bot_id + instrument so multi-bot setups can
    // attribute correctly. Constraint: each instrument can only have
    // ONE running bot at a time per sub-account in v0 — fills are
    // attributed by instrument lookup against grid_bots.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS fills_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fill_id TEXT UNIQUE,
        event_time TEXT,
        is_buyer INTEGER,
        price REAL,
        size REAL,
        fee REAL,
        created_at TEXT,
        bot_id INTEGER REFERENCES grid_bots(id) ON DELETE SET NULL,
        instrument TEXT
      )
    `);

    // Migration: add bot_id + instrument to legacy installs.
    try {
      await this.dbRun(`ALTER TABLE fills_archive ADD COLUMN bot_id INTEGER REFERENCES grid_bots(id) ON DELETE SET NULL`);
      console.log('✅ Columna bot_id agregada a fills_archive');
    } catch (e) { /* already exists */ }
    try {
      await this.dbRun(`ALTER TABLE fills_archive ADD COLUMN instrument TEXT`);
      console.log('✅ Columna instrument agregada a fills_archive');
    } catch (e) { /* already exists */ }

    // Backfill rows with NULL bot_id by attributing to the only bot whose
    // pair MIGHT have generated them. This is a best-effort migration:
    // if there's exactly ONE bot in the table, all NULL rows go to it.
    // If there are multiple bots already, leave NULLs alone (the operator
    // must manually attribute or accept that legacy fills are unattributed).
    await this.dbRun(`
      UPDATE fills_archive
      SET bot_id = (SELECT id FROM grid_bots LIMIT 1),
          instrument = (SELECT pair FROM grid_bots LIMIT 1)
      WHERE bot_id IS NULL
        AND (SELECT COUNT(*) FROM grid_bots) = 1
    `);

    await this.dbRun(`
      CREATE INDEX IF NOT EXISTS idx_fills_archive_bot
        ON fills_archive(bot_id, event_time)
    `);
    await this.dbRun(`
      CREATE INDEX IF NOT EXISTS idx_fills_archive_instrument
        ON fills_archive(instrument, event_time)
    `);

    // Tabla: paired_roundtrips - round-trips emparejados (buy + sell)
    // Source of truth for accurate round-trip counting (vs the buggy
    // sells-in-trades-table heuristic that froze in createDailySnapshots).
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS paired_roundtrips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        buy_fill_id TEXT,
        sell_fill_id TEXT,
        buy_price REAL,
        sell_price REAL,
        size REAL,
        profit REAL,
        created_at TEXT,
        UNIQUE(buy_fill_id, sell_fill_id)
      )
    `);

    // Índices para performance
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_bots_status ON grid_bots(status)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_grid_levels_bot_id ON grid_levels(bot_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_orders_bot_id ON orders(bot_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_trades_bot_id ON trades(bot_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_funding_bot_id ON funding_history(bot_id)`);

    // ─── Multi-tenancy migration ────────────────────────────────────
    // Adds users + grvt_credentials + terms_acceptances + user_id on
    // every per-bot table. Idempotent: each ALTER is wrapped in
    // try/catch since SQLite has no `IF NOT EXISTS` for ALTER.
    // See plan: C:\Users\52553\.claude\plans\virtual-splashing-ocean.md
    await this.runMultitenantMigration();

    console.log('📋 Tablas creadas/verificadas');
  }

  private async runMultitenantMigration(): Promise<void> {
    // Schema version tracking — first applied = 1.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    // users — one row per account. Owner is user_id=1, created via
    // owner bootstrap (see initialize()).
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        accepted_referral_link INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      )
    `);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

    // grvt_credentials — AES-256-GCM encrypted GRVT API + signing
    // material. One row per user. Each field has its own IV+tag
    // because GCM requires unique IV per ciphertext under same key.
    // Master key lives at MASTER_KEY_PATH on disk; losing it means
    // every user must re-paste their credentials.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS grvt_credentials (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_api_key TEXT NOT NULL,
        api_key_iv TEXT NOT NULL,
        api_key_tag TEXT NOT NULL,
        encrypted_api_secret TEXT NOT NULL,
        api_secret_iv TEXT NOT NULL,
        api_secret_tag TEXT NOT NULL,
        encrypted_trading_address TEXT NOT NULL,
        trading_address_iv TEXT NOT NULL,
        trading_address_tag TEXT NOT NULL,
        encrypted_account_id TEXT NOT NULL,
        account_id_iv TEXT NOT NULL,
        account_id_tag TEXT NOT NULL,
        encrypted_sub_account_id TEXT NOT NULL,
        sub_account_id_iv TEXT NOT NULL,
        sub_account_id_tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        last_test_ok INTEGER,
        last_test_at INTEGER,
        last_test_error TEXT
      )
    `);

    // terms_acceptances — append-only audit log. Stores the EXACT
    // text shown to the user at the moment of acceptance, plus IP
    // and user agent, so we can prove what they saw if anything is
    // ever disputed. context distinguishes signup TOS from per-bot
    // risk acceptance.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS terms_acceptances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        context TEXT NOT NULL,
        context_ref INTEGER,
        accepted_at INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        terms_version TEXT NOT NULL,
        terms_text_hash TEXT NOT NULL,
        terms_text TEXT NOT NULL
      )
    `);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_terms_user ON terms_acceptances(user_id)`);

    // ALTER existing tables to add user_id. Wrapped in try/catch
    // because SQLite doesn't support `ADD COLUMN IF NOT EXISTS`.
    // The columns are nullable; backfill happens in ownerBootstrap().
    const tablesToAlter = [
      'grid_bots',
      'grid_levels',
      'orders',
      'trades',
      'funding_history',
      'daily_snapshots',
      'fills_archive',
      'bot_cash_movements',
      'paired_roundtrips',
    ];
    for (const table of tablesToAlter) {
      try {
        await this.dbRun(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id)`);
        console.log(`✅ Columna user_id agregada a ${table}`);
      } catch (e) {
        // Already exists, ignore.
      }
    }
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_grid_bots_user ON grid_bots(user_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id)`);
    await this.dbRun(`CREATE INDEX IF NOT EXISTS idx_fills_arch_user ON fills_archive(user_id)`);

    // ─── Triggers: auto-fill user_id on child rows ────────────────
    // Strategy: instead of refactoring every existing createX() to
    // accept and propagate user_id, we let SQLite derive it from the
    // parent grid_bots row at insert time. This keeps the blast
    // radius small (only grid_bots.createBot() needs to know about
    // user_id at the application level) and guarantees consistency
    // — there's no way to forget to set user_id on a child row.
    //
    // Each trigger fires AFTER INSERT and updates the just-inserted
    // row's user_id from the parent. Idempotent: DROP+CREATE.
    const childTables: Array<{ table: string; parentJoin: string }> = [
      { table: 'grid_levels',        parentJoin: 'NEW.bot_id' },
      { table: 'orders',             parentJoin: 'NEW.bot_id' },
      { table: 'trades',             parentJoin: 'NEW.bot_id' },
      { table: 'funding_history',    parentJoin: 'NEW.bot_id' },
      { table: 'daily_snapshots',    parentJoin: 'NEW.bot_id' },
      { table: 'bot_cash_movements', parentJoin: 'NEW.bot_id' },
      { table: 'fills_archive',      parentJoin: 'NEW.bot_id' },
    ];
    for (const { table, parentJoin } of childTables) {
      const triggerName = `trg_${table}_user_id`;
      await this.dbRun(`DROP TRIGGER IF EXISTS ${triggerName}`);
      await this.dbRun(`
        CREATE TRIGGER ${triggerName}
        AFTER INSERT ON ${table}
        FOR EACH ROW
        WHEN NEW.user_id IS NULL AND ${parentJoin} IS NOT NULL
        BEGIN
          UPDATE ${table}
          SET user_id = (SELECT user_id FROM grid_bots WHERE id = ${parentJoin})
          WHERE rowid = NEW.rowid;
        END
      `);
    }

    // Stamp version 1 (idempotent).
    await this.dbRun(`
      INSERT OR IGNORE INTO schema_version (version, applied_at)
      VALUES (1, ?)
    `, [Date.now()]);
  }

  // === CRUD para grid_bots ===

  /**
   * Crear nuevo grid bot
   */
  async createBot(params: Omit<GridBot, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    // Compute the canonical per-level qty ONCE, at creation, and store
    // it immutably. Same formula as the legacy getFixedQty() but only
    // ever evaluated here, so subsequent compounds and updateBotRange
    // calls cannot drift it.
    const ORDER_ALLOC = 0.75;
    const midPrice = (params.lower_price + params.upper_price) / 2;
    const effCap = params.investment_usdt * params.leverage * ORDER_ALLOC;
    const computedQty = Math.max(
      Math.ceil((effCap / params.num_grids / midPrice) * 100) / 100,
      0.03
    );
    // Allow caller override (e.g. wizard preview) but default to the
    // formula above when params.quantity_per_level is not provided.
    const quantityPerLevel = params.quantity_per_level ?? computedQty;

    // Multi-tenant: user_id is required for all new bots. Owners that
    // upgraded from single-tenant get backfilled to user_id=1 by the
    // owner bootstrap; the application is expected to always pass it
    // explicitly going forward. We accept undefined here only as a
    // transition affordance and let the trigger backfill from the
    // parent (which won't happen if it's null on the parent itself).
    if (params.user_id == null) {
      console.warn(`⚠️  createBot called without user_id — this should only happen during legacy migration`);
    }

    // Set original_investment_usdt = investment_usdt at creation. After
    // this point, investment_usdt may drift (compound, manual edits) but
    // the original is immutable so we always know the real cash deposit.
    const values = [
      params.user_id ?? null,
      params.pair, params.direction, params.leverage, params.lower_price,
      params.upper_price, params.num_grids, params.investment_usdt,
      params.investment_usdt,  // original_investment_usdt = investment_usdt
      quantityPerLevel,        // immutable per-level qty
      params.grid_profit_usdt, params.trend_pnl_usdt, params.total_pnl_usdt,
      params.status, params.position_size, params.avg_entry_price,
      params.liquidation_price, params.params_json
    ];
    const sql = `
      INSERT INTO grid_bots (
        user_id,
        pair, direction, leverage, lower_price, upper_price, num_grids,
        investment_usdt, original_investment_usdt, quantity_per_level,
        grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
        status, position_size, avg_entry_price, liquidation_price, params_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.dbRun(sql, values);
    const row = await this.dbGet('SELECT last_insert_rowid() as id');
    const botId = row.id as number;

    // Seed the cash-movements ledger with the initial deposit so the
    // history is complete from day 1.
    await this.dbRun(`
      INSERT INTO bot_cash_movements (bot_id, type, amount_usdt, notes)
      VALUES (?, 'initial', ?, 'Initial investment at bot creation')
    `, [botId, params.investment_usdt]);

    return botId;
  }

  /**
   * Record a cash movement against a bot. Used by:
   *   - compound rebalance ('compound')
   *   - manual external deposits ('deposit')
   *   - manual withdrawals ('withdrawal')
   *
   * The 'initial' type is only used by createBot().
   *
   * Recording movements lets the dashboard report:
   *   bot.original_investment_usdt
   *     + Σ deposits + Σ compounds − Σ withdrawals
   *     = current notional
   * with full provenance.
   */
  async recordCashMovement(params: {
    bot_id: number;
    type: 'compound' | 'deposit' | 'withdrawal';
    amount_usdt: number;
    notes?: string;
  }): Promise<number> {
    const result = await this.dbRun(`
      INSERT INTO bot_cash_movements (bot_id, type, amount_usdt, notes)
      VALUES (?, ?, ?, ?)
    `, [params.bot_id, params.type, params.amount_usdt, params.notes ?? null]);
    return result.lastID ?? 0;
  }

  /**
   * Total amount the compound rebalance has already pulled out of the
   * bot's grid profit. Used by checkCompoundRebalance() to avoid
   * double-counting the same profit on successive runs.
   */
  async getCompoundedTotal(botId: number): Promise<number> {
    const row = await this.dbGet(`
      SELECT COALESCE(SUM(amount_usdt), 0) AS total
      FROM bot_cash_movements
      WHERE bot_id = ? AND type = 'compound'
    `, botId);
    return (row?.total as number | undefined) ?? 0;
  }

  async listCashMovements(botId: number): Promise<Array<{
    id: number;
    type: string;
    amount_usdt: number;
    notes: string | null;
    occurred_at: string;
  }>> {
    return this.dbAll(`
      SELECT id, type, amount_usdt, notes, occurred_at
      FROM bot_cash_movements
      WHERE bot_id = ?
      ORDER BY occurred_at ASC
    `, botId);
  }

  /**
   * Obtener bot por ID
   */
  async getBot(botId: number): Promise<GridBot | null> {
    return await this.dbGet(`SELECT * FROM grid_bots WHERE id = ?`, [botId]);
  }

  /**
   * Obtener todos los bots
   */
  async getAllBots(): Promise<GridBot[]> {
    return await this.dbAll(`SELECT * FROM grid_bots ORDER BY created_at DESC`);
  }

  /**
   * Obtener bots por status
   */
  async getBotsByStatus(status: string): Promise<GridBot[]> {
    return await this.dbAll(`SELECT * FROM grid_bots WHERE status = ?`, [status]);
  }

  /**
   * Actualizar bot
   */
  async updateBot(botId: number, updates: Partial<GridBot>): Promise<void> {
    const fields = Object.keys(updates).filter(key => key !== 'id').map(key => `${key} = ?`);
    const values = Object.entries(updates)
      .filter(([key]) => key !== 'id')
      .map(([, value]) => value);
    
    if (fields.length === 0) return;

    await this.dbRun(`
      UPDATE grid_bots 
      SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [...values, botId]);
  }

  /**
   * Borrar bot (cascade a todas las tablas relacionadas)
   */
  async deleteBot(botId: number): Promise<void> {
    await this.dbRun(`DELETE FROM grid_bots WHERE id = ?`, [botId]);
  }

  // === CRUD para grid_levels ===

  /**
   * Crear nivel de grid
   */
  async createGridLevel(params: Omit<GridLevel, 'id' | 'created_at'>): Promise<number> {
    const values = [params.bot_id, params.level_index, params.price, params.side, 
        params.quantity, params.is_filled ? 1 : 0, params.order_id || null, params.filled_at || null];
    const sql = `INSERT INTO grid_levels (bot_id, level_index, price, side, quantity, is_filled, order_id, filled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    await this.dbRun(sql, values);
    const row = await this.dbGet('SELECT last_insert_rowid() as id');
    return row.id;
  }

  /**
   * Obtener niveles de grid de un bot
   */
  async getGridLevels(botId: number): Promise<GridLevel[]> {
    return await this.dbAll(`
      SELECT * FROM grid_levels 
      WHERE bot_id = ? 
      ORDER BY level_index
    `, [botId]);
  }

  /**
   * Marcar nivel como completado
   */
  async fillGridLevel(levelId: number, orderId: string): Promise<void> {
    await this.dbRun(`
      UPDATE grid_levels 
      SET is_filled = 1, order_id = ?, filled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [orderId, levelId]);
  }

  /**
   * Marcar nivel como pendiente de colocación (error 7201)
   */
  async markLevelPendingReplace(levelId: number): Promise<void> {
    await this.dbRun(`
      UPDATE grid_levels 
      SET pending_replace = 1
      WHERE id = ?
    `, [levelId]);
  }

  /**
   * Limpiar pending_replace del nivel
   */
  async clearLevelPendingReplace(levelId: number): Promise<void> {
    await this.dbRun(`
      UPDATE grid_levels 
      SET pending_replace = 0
      WHERE id = ?
    `, [levelId]);
  }

  /**
   * Actualizar order_id de un nivel (sin marcar como filled)
   */
  async updateGridLevelOrderId(levelId: number, orderId: string): Promise<void> {
    await this.dbRun(`
      UPDATE grid_levels 
      SET order_id = ?
      WHERE id = ?
    `, [orderId, levelId]);
  }

  /**
   * Obtener niveles pendientes de reemplazo
   */
  async getPendingReplaceGridLevels(botId: number): Promise<GridLevel[]> {
    return await this.dbAll(`
      SELECT * FROM grid_levels 
      WHERE bot_id = ? AND pending_replace = 1
      ORDER BY level_index
    `, [botId]);
  }

  /**
   * Actualizar campos de un grid level
   */
  async updateGridLevel(levelId: number, updates: Partial<Pick<GridLevel, 'side' | 'is_filled' | 'order_id' | 'pending_replace' | 'quantity'>>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.side !== undefined) {
      fields.push('side = ?');
      values.push(updates.side);
    }
    if (updates.is_filled !== undefined) {
      fields.push('is_filled = ?');
      values.push(updates.is_filled ? 1 : 0);
    }
    if (updates.order_id !== undefined) {
      fields.push('order_id = ?');
      values.push(updates.order_id);
    }
    if (updates.pending_replace !== undefined) {
      fields.push('pending_replace = ?');
      values.push(updates.pending_replace ? 1 : 0);
    }
    if (updates.quantity !== undefined) {
      fields.push('quantity = ?');
      values.push(updates.quantity);
    }
    
    if (fields.length === 0) return; // No updates
    
    values.push(levelId);
    
    await this.dbRun(`
      UPDATE grid_levels 
      SET ${fields.join(', ')}
      WHERE id = ?
    `, values);
  }

  async deleteGridLevel(levelId: number): Promise<void> {
    await this.dbRun(`DELETE FROM grid_levels WHERE id = ?`, [levelId]);
  }

  async deleteGridLevelsOutsideRange(botId: number, lower: number, upper: number): Promise<number> {
    const result = await this.dbRun(`
      DELETE FROM grid_levels
      WHERE bot_id = ? AND (price < ? OR price > ?)
    `, [botId, lower, upper]);

    return result.changes || 0;
  }

  /**
   * Atomically replace ALL grid levels for a bot. Used by the
   * range update operation: deletes everything, inserts the fresh
   * 0..N level set, all in a single transaction so a crash mid-flight
   * cannot leave a partial grid in the DB.
   *
   * Critical for the level_index UNIQUE collision fix: by deleting
   * all old rows BEFORE inserting new ones with reused level_index
   * values, we never violate the UNIQUE(bot_id, level_index) constraint.
   */
  async replaceAllGridLevels(
    botId: number,
    newLevels: Array<{
      level_index: number;
      price: number;
      side: 'buy' | 'sell';
      quantity: number;
    }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        this.db.run('DELETE FROM grid_levels WHERE bot_id = ?', [botId], (delErr) => {
          if (delErr) {
            this.db.run('ROLLBACK');
            return reject(delErr);
          }
          let pending = newLevels.length;
          if (pending === 0) {
            this.db.run('COMMIT', (commitErr) => {
              if (commitErr) reject(commitErr);
              else resolve();
            });
            return;
          }
          let failed = false;
          for (const level of newLevels) {
            this.db.run(
              `INSERT INTO grid_levels (bot_id, level_index, price, side, quantity, is_filled, order_id)
               VALUES (?, ?, ?, ?, ?, 0, '0x00')`,
              [botId, level.level_index, level.price, level.side, level.quantity],
              (insErr) => {
                if (failed) return;
                if (insErr) {
                  failed = true;
                  this.db.run('ROLLBACK');
                  return reject(insErr);
                }
                pending--;
                if (pending === 0 && !failed) {
                  this.db.run('COMMIT', (commitErr) => {
                    if (commitErr) reject(commitErr);
                    else resolve();
                  });
                }
              }
            );
          }
        });
      });
    });
  }

  // === CRUD para orders ===

  /**
   * Crear registro de orden
   */
  async createOrder(params: Omit<OrderRecord, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    try {
      const result = await this.dbRun(`
        INSERT INTO orders (bot_id, order_id, instrument, side, type, quantity, price, status, grid_level_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [params.bot_id, params.order_id, params.instrument, params.side, params.type,
          params.quantity, params.price, params.status, params.grid_level_id, params.metadata]);

      return result.lastID!;
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint') && 
          (params.order_id === '0x00' || params.order_id.startsWith('0x000000'))) {
        params.order_id = `temp_${Date.now()}_${params.price}`;
        console.log(`[DB] UNIQUE constraint workaround: renamed to ${params.order_id}`);
        const result = await this.dbRun(`
          INSERT INTO orders (bot_id, order_id, instrument, side, type, quantity, price, status, grid_level_id, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [params.bot_id, params.order_id, params.instrument, params.side, params.type,
            params.quantity, params.price, params.status, params.grid_level_id, params.metadata]);
        return result.lastID!;
      }
      throw err;
    }
  }

  /**
   * Obtener órdenes de un bot
   */
  async getOrdersByBot(botId: number): Promise<OrderRecord[]> {
    return await this.dbAll(`
      SELECT * FROM orders 
      WHERE bot_id = ? 
      ORDER BY created_at DESC
    `, [botId]);
  }

  /**
   * Actualizar status de orden
   */
  async updateOrderStatus(orderId: string, status: string): Promise<void> {
    await this.dbRun(`
      UPDATE orders 
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE order_id = ?
    `, [status, orderId]);
  }

  // === CRUD para trades ===

  /**
   * Crear registro de trade
   */
  async createTrade(params: Omit<TradeRecord, 'id' | 'created_at'>): Promise<number> {
    const result = await this.dbRun(`
      INSERT INTO trades (bot_id, order_id, fill_id, side, quantity, price, fee, fee_currency, pnl_usdt, round_trip_profit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [params.bot_id, params.order_id, params.fill_id, params.side, params.quantity,
        params.price, params.fee, params.fee_currency, params.pnl_usdt, params.round_trip_profit]);

    return result.lastID!;
  }

  /**
   * Obtener trades de un bot
   */
  async getTradesByBot(botId: number): Promise<TradeRecord[]> {
    return await this.dbAll(`
      SELECT * FROM trades 
      WHERE bot_id = ? 
      ORDER BY created_at DESC
    `, [botId]);
  }

  /**
   * Obtener trades más recientes (para health check)
   */
  async getRecentTrades(limit: number = 10): Promise<TradeRecord[]> {
    return await this.dbAll(`
      SELECT * FROM trades 
      ORDER BY created_at DESC 
      LIMIT ?
    `, [limit]);
  }

  // === CRUD para funding_history ===

  /**
   * Crear registro de funding
   */
  async createFundingRecord(params: Omit<FundingRecord, 'id' | 'created_at'>): Promise<number> {
    const result = await this.dbRun(`
      INSERT INTO funding_history (bot_id, instrument, funding_rate, payment_usdt, position_size, funding_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [params.bot_id, params.instrument, params.funding_rate, 
        params.payment_usdt, params.position_size, params.funding_time]);

    return result.lastID!;
  }

  /**
   * Obtener funding history de un bot
   */
  async getFundingHistoryByBot(botId: number): Promise<FundingRecord[]> {
    return await this.dbAll(`
      SELECT * FROM funding_history 
      WHERE bot_id = ? 
      ORDER BY funding_time DESC
    `, [botId]);
  }

  // === CRUD para daily_snapshots ===

  /**
   * Crear snapshot diario
   */
  async createDailySnapshot(params: Omit<DailySnapshot, 'id' | 'created_at'>): Promise<number> {
    const result = await this.dbRun(`
      INSERT OR REPLACE INTO daily_snapshots 
      (bot_id, date, equity, grid_profit_net, trend_pnl, total_pnl, round_trips, eth_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      params.bot_id, 
      params.date, 
      params.equity, 
      params.grid_profit_net, 
      params.trend_pnl, 
      params.total_pnl, 
      params.round_trips, 
      params.eth_price
    ]);

    return result.lastID!;
  }

  /**
   * Obtener snapshots diarios de un bot
   */
  async getDailySnapshotsByBot(botId: number, limitDays?: number): Promise<DailySnapshot[]> {
    const limit = limitDays ? `LIMIT ${limitDays}` : '';
    return await this.dbAll(`
      SELECT * FROM daily_snapshots 
      WHERE bot_id = ? 
      ORDER BY date DESC
      ${limit}
    `, [botId]);
  }

  /**
   * Obtener último snapshot de un bot
   */
  async getLastDailySnapshot(botId: number): Promise<DailySnapshot | null> {
    return await this.dbGet(`
      SELECT * FROM daily_snapshots 
      WHERE bot_id = ? 
      ORDER BY date DESC 
      LIMIT 1
    `, [botId]);
  }

  /**
   * Verificar si ya existe snapshot para una fecha
   */
  async hasSnapshotForDate(botId: number, date: string): Promise<boolean> {
    const result = await this.dbGet(`
      SELECT 1 FROM daily_snapshots
      WHERE bot_id = ? AND date = ?
    `, [botId, date]);

    return !!result;
  }

  // === fills_archive ===

  /**
   * Insert a fill into fills_archive. Idempotent: uses INSERT OR IGNORE
   * keyed on the unique fill_id, so calling it twice with the same fill
   * is safe and returns 0 changes the second time. Returns true if a new
   * row was inserted, false if it was a duplicate.
   *
   * Multi-bot: caller MUST provide bot_id and instrument so the row can
   * be filtered correctly. v0 attribution is by instrument lookup
   * (one running bot per instrument per sub-account).
   */
  async insertFillArchive(params: {
    fill_id: string;
    event_time: string;
    is_buyer: number;
    price: number;
    size: number;
    fee: number;
    created_at: string;
    bot_id: number | null;
    instrument: string | null;
  }): Promise<boolean> {
    const result = await this.dbRun(`
      INSERT OR IGNORE INTO fills_archive
        (fill_id, event_time, is_buyer, price, size, fee, created_at, bot_id, instrument)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      params.fill_id,
      params.event_time,
      params.is_buyer,
      params.price,
      params.size,
      params.fee,
      params.created_at,
      params.bot_id,
      params.instrument,
    ]);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Latest event_time we've stored, as a nanosecond string. Used by the
   * fill poller to ask GRVT only for fills newer than the watermark.
   * Returns null if the table is empty.
   */
  async getLatestFillEventTime(): Promise<string | null> {
    const row = await this.dbGet(`
      SELECT MAX(event_time) AS et FROM fills_archive
    `);
    return (row?.et as string | undefined) ?? null;
  }

  /**
   * Aggregate fee summary for the rebates stat. Sum is the sum of raw
   * fee values (negative for maker rebates), so a NEGATIVE sum means
   * the user EARNED that much. count is included so the dashboard can
   * show "N fills, $X earned".
   */
  async getFillFeeSummary(): Promise<{
    count: number;
    sumFee: number;
    minFee: number;
    maxFee: number;
  }> {
    const row = await this.dbGet(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(fee), 0) AS sum_fee,
             MIN(fee) AS min_fee,
             MAX(fee) AS max_fee
      FROM fills_archive
    `) as { count: number; sum_fee: number | null; min_fee: number | null; max_fee: number | null } | undefined;
    return {
      count: row?.count ?? 0,
      sumFee: row?.sum_fee ?? 0,
      minFee: row?.min_fee ?? 0,
      maxFee: row?.max_fee ?? 0,
    };
  }

  /**
   * List archived fills, newest first, paginated. Used by the v2
   * /fills endpoint that replaces the dead /trades reads.
   */
  async listFillArchive(limit: number = 200): Promise<Array<{
    id: number;
    fill_id: string;
    event_time: string;
    is_buyer: number;
    price: number;
    size: number;
    fee: number;
    created_at: string;
  }>> {
    return this.dbAll(`
      SELECT id, fill_id, event_time, is_buyer, price, size, fee, created_at
      FROM fills_archive
      ORDER BY event_time DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Fills for a specific bot, ordered chronologically. Used by the
   * engine's calculateRealGridProfit() — must filter by bot_id so the
   * spread-pair matcher only sees this bot's fills, not the entire
   * sub-account history. Bot 44 hit a leak when this filter was
   * missing on 2026-04-08 (inherited bot 42's $76 profit).
   */
  async getFillsForBot(botId: number): Promise<Array<{
    is_buyer: number;
    price: number;
    size: number;
    fee: number;
    event_time: string;
  }>> {
    return this.dbAll(`
      SELECT is_buyer, price, size, fee, event_time
      FROM fills_archive
      WHERE bot_id = ?
      ORDER BY event_time ASC
    `, [botId]);
  }

  /**
   * Compute realized PnL by FIFO matching every fill in fills_archive.
   *
   * Algorithm: walk fills oldest→newest, maintain a queue of open BUY lots
   * `[{ price, qtyRemaining }]`. Each SELL consumes from the head of the
   * queue until its size is covered, accumulating profit as
   * `(sellPrice - buyPrice) * matchedQty`. Any leftover BUY lots represent
   * the currently open position (reported as openSize / openCost).
   *
   * This is the same FIFO realized-PnL convention used by every major
   * exchange. Inputs are 100% real GRVT fill data — no estimation, no
   * heuristic spread, no assumed grid level pairing.
   *
   * Notes:
   *   - Fees come straight from fills_archive.fee (signed; negative =
   *     maker rebate earned). totalFees is the SUM, so a negative value
   *     means the user has net-earned rebates.
   *   - netPnl = realizedPnl - totalFees (subtracting because positive
   *     fee = paid; negative fee = earned and INCREASES netPnl).
   *   - Bot is currently LONG-only (BUY-then-SELL). For SHORT bots we'd
   *     need to mirror: queue SELL lots and consume on BUY. Not yet
   *     supported here — guarded by an assertion if we see SHORT data
   *     later.
   */
  async computeRealizedFifo(): Promise<{
    realizedPnl: number;
    totalFees: number;
    netPnl: number;
    roundTrips: number;
    avgPerRT: number;
    fillCount: number;
    openSize: number;
    openCost: number;
    firstFillAt: string | null;
    lastFillAt: string | null;
  }> {
    const fills = await this.dbAll(`
      SELECT is_buyer, price, size, fee, event_time
      FROM fills_archive
      ORDER BY event_time ASC
    `) as Array<{
      is_buyer: number;
      price: number;
      size: number;
      fee: number;
      event_time: string;
    }>;

    if (fills.length === 0) {
      return {
        realizedPnl: 0,
        totalFees: 0,
        netPnl: 0,
        roundTrips: 0,
        avgPerRT: 0,
        fillCount: 0,
        openSize: 0,
        openCost: 0,
        firstFillAt: null,
        lastFillAt: null,
      };
    }

    // Each entry is one BUY lot waiting to be matched against a future SELL.
    const lots: Array<{ price: number; qty: number }> = [];
    let realizedPnl = 0;
    let totalFees = 0;
    let roundTrips = 0;

    // Tiny epsilon to absorb float drift when consuming a lot exactly.
    const EPS = 1e-9;

    for (const f of fills) {
      totalFees += f.fee;
      if (f.is_buyer === 1) {
        lots.push({ price: f.price, qty: f.size });
        continue;
      }
      // SELL: consume from oldest BUY lots first.
      let remaining = f.size;
      while (remaining > EPS && lots.length > 0) {
        const lot = lots[0]!;
        const matched = Math.min(lot.qty, remaining);
        realizedPnl += (f.price - lot.price) * matched;
        roundTrips++;
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= EPS) lots.shift();
      }
      // If `remaining > EPS` here, we had a SELL with no matching BUY lot
      // — that would mean either a SHORT bot or pre-existing position.
      // For LONG bots this should not happen; we silently ignore the
      // unmatched portion rather than crash so the endpoint stays robust.
    }

    const openSize = lots.reduce((acc, l) => acc + l.qty, 0);
    const openCost = lots.reduce((acc, l) => acc + l.qty * l.price, 0);
    const fillCount = fills.length;
    const netPnl = realizedPnl - totalFees;
    const avgPerRT = roundTrips > 0 ? realizedPnl / roundTrips : 0;

    return {
      realizedPnl,
      totalFees,
      netPnl,
      roundTrips,
      avgPerRT,
      fillCount,
      openSize,
      openCost,
      firstFillAt: fills[0]!.event_time,
      lastFillAt: fills[fills.length - 1]!.event_time,
    };
  }

  // === paired_roundtrips ===

  /**
   * Insert a paired round-trip. Idempotent on the (buy_fill_id, sell_fill_id)
   * unique constraint.
   */
  async insertPairedRoundtrip(params: {
    buy_fill_id: string;
    sell_fill_id: string;
    buy_price: number;
    sell_price: number;
    size: number;
    profit: number;
    created_at: string;
  }): Promise<boolean> {
    const result = await this.dbRun(`
      INSERT OR IGNORE INTO paired_roundtrips
        (buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      params.buy_fill_id,
      params.sell_fill_id,
      params.buy_price,
      params.sell_price,
      params.size,
      params.profit,
      params.created_at,
    ]);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Contar round-trips emparejados (source of truth real para num_round_trips).
   * NOTE: la tabla paired_roundtrips no tiene bot_id (es global). Cuando
   * Phase B introduzca multi-bot habrá que migrar esta tabla a tener bot_id.
   */
  async countPairedRoundtrips(): Promise<number> {
    const row = await this.dbGet(`SELECT COUNT(*) as c FROM paired_roundtrips`);
    return row?.c || 0;
  }

  /**
   * Sum total profit from all paired round-trips
   */
  async sumPairedRoundtripProfit(): Promise<number> {
    const row = await this.dbGet(`SELECT COALESCE(SUM(profit), 0) as p FROM paired_roundtrips`);
    return row?.p || 0;
  }

  /**
   * Escape hatch: return the raw sqlite3.Database handle.
   * Used by the v2 server (ws-dispatcher, v2-router) which need direct
   * `db.all` / `db.get` access for parameterized queries that don't fit
   * the wrapper's narrow CRUD methods. Do NOT use this in regular bot
   * logic — it bypasses the typed helpers.
   */
  getRawDb(): sqlite3.Database {
    return this.db;
  }

  // === Utilidades ===

  /**
   * Obtener estadísticas generales
   */
  async getStats(): Promise<{
    totalBots: number;
    activeBots: number;
    totalPnl: number;
    totalTrades: number;
  }> {
    const [botsCount, activeCount, pnlSum, tradesCount] = await Promise.all([
      this.dbGet(`SELECT COUNT(*) as count FROM grid_bots`),
      this.dbGet(`SELECT COUNT(*) as count FROM grid_bots WHERE status = 'running'`),
      this.dbGet(`SELECT COALESCE(SUM(total_pnl_usdt), 0) as total FROM grid_bots`),
      this.dbGet(`SELECT COUNT(*) as count FROM trades`)
    ]);

    return {
      totalBots: botsCount.count,
      activeBots: activeCount.count,
      totalPnl: pnlSum.total,
      totalTrades: tradesCount.count
    };
  }

  // ─── Multi-tenant: users ───────────────────────────────────────

  async createUser(params: {
    email: string;
    password_hash: string;
    is_admin?: boolean;
  }): Promise<number> {
    const result = await this.dbRun(
      `INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)`,
      [params.email, params.password_hash, params.is_admin ? 1 : 0, Date.now()]
    );
    return result.lastID ?? 0;
  }

  async getUserByEmail(email: string): Promise<{
    id: number;
    email: string;
    password_hash: string;
    is_admin: number;
    created_at: number;
    last_login_at: number | null;
  } | null> {
    return await this.dbGet(`SELECT * FROM users WHERE email = ?`, [email]);
  }

  async getUserById(id: number): Promise<{
    id: number;
    email: string;
    password_hash: string;
    is_admin: number;
    created_at: number;
    last_login_at: number | null;
  } | null> {
    return await this.dbGet(`SELECT * FROM users WHERE id = ?`, [id]);
  }

  async updateUserLastLogin(userId: number): Promise<void> {
    await this.dbRun(
      `UPDATE users SET last_login_at = ? WHERE id = ?`,
      [Date.now(), userId]
    );
  }

  async countUsers(): Promise<number> {
    const row = await this.dbGet(`SELECT COUNT(*) as c FROM users`);
    return (row?.c as number) ?? 0;
  }

  // ─── Multi-tenant: terms acceptances ───────────────────────────

  async insertTermsAcceptance(params: {
    user_id: number;
    context: 'signup' | 'create_bot' | 'update_credentials';
    context_ref?: number | null;
    ip_address: string | null;
    user_agent: string | null;
    terms_version: string;
    terms_text: string;
    terms_text_hash: string;
  }): Promise<void> {
    await this.dbRun(
      `INSERT INTO terms_acceptances
        (user_id, context, context_ref, accepted_at, ip_address, user_agent, terms_version, terms_text_hash, terms_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.user_id,
        params.context,
        params.context_ref ?? null,
        Date.now(),
        params.ip_address,
        params.user_agent,
        params.terms_version,
        params.terms_text_hash,
        params.terms_text,
      ]
    );
  }

  // ─── Multi-tenant: grvt_credentials ────────────────────────────
  // Stores AES-256-GCM encrypted credential fields. Each field has
  // its own IV and auth tag. Reads return the raw encrypted blob;
  // decryption happens in the api/grvt-client-factory layer.

  async upsertGrvtCredentials(params: {
    user_id: number;
    encrypted_api_key: string;        api_key_iv: string;        api_key_tag: string;
    encrypted_api_secret: string;     api_secret_iv: string;     api_secret_tag: string;
    encrypted_trading_address: string;trading_address_iv: string;trading_address_tag: string;
    encrypted_account_id: string;     account_id_iv: string;     account_id_tag: string;
    encrypted_sub_account_id: string; sub_account_id_iv: string; sub_account_id_tag: string;
    last_test_ok: boolean;
    last_test_error?: string | null;
  }): Promise<void> {
    const now = Date.now();
    await this.dbRun(
      `INSERT INTO grvt_credentials (
        user_id,
        encrypted_api_key, api_key_iv, api_key_tag,
        encrypted_api_secret, api_secret_iv, api_secret_tag,
        encrypted_trading_address, trading_address_iv, trading_address_tag,
        encrypted_account_id, account_id_iv, account_id_tag,
        encrypted_sub_account_id, sub_account_id_iv, sub_account_id_tag,
        created_at, last_test_ok, last_test_at, last_test_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        encrypted_api_key = excluded.encrypted_api_key,
        api_key_iv = excluded.api_key_iv,
        api_key_tag = excluded.api_key_tag,
        encrypted_api_secret = excluded.encrypted_api_secret,
        api_secret_iv = excluded.api_secret_iv,
        api_secret_tag = excluded.api_secret_tag,
        encrypted_trading_address = excluded.encrypted_trading_address,
        trading_address_iv = excluded.trading_address_iv,
        trading_address_tag = excluded.trading_address_tag,
        encrypted_account_id = excluded.encrypted_account_id,
        account_id_iv = excluded.account_id_iv,
        account_id_tag = excluded.account_id_tag,
        encrypted_sub_account_id = excluded.encrypted_sub_account_id,
        sub_account_id_iv = excluded.sub_account_id_iv,
        sub_account_id_tag = excluded.sub_account_id_tag,
        last_test_ok = excluded.last_test_ok,
        last_test_at = excluded.last_test_at,
        last_test_error = excluded.last_test_error
      `,
      [
        params.user_id,
        params.encrypted_api_key, params.api_key_iv, params.api_key_tag,
        params.encrypted_api_secret, params.api_secret_iv, params.api_secret_tag,
        params.encrypted_trading_address, params.trading_address_iv, params.trading_address_tag,
        params.encrypted_account_id, params.account_id_iv, params.account_id_tag,
        params.encrypted_sub_account_id, params.sub_account_id_iv, params.sub_account_id_tag,
        now, params.last_test_ok ? 1 : 0, now, params.last_test_error ?? null,
      ]
    );
  }

  async getGrvtCredentialsRaw(userId: number): Promise<{
    user_id: number;
    encrypted_api_key: string;        api_key_iv: string;        api_key_tag: string;
    encrypted_api_secret: string;     api_secret_iv: string;     api_secret_tag: string;
    encrypted_trading_address: string;trading_address_iv: string;trading_address_tag: string;
    encrypted_account_id: string;     account_id_iv: string;     account_id_tag: string;
    encrypted_sub_account_id: string; sub_account_id_iv: string; sub_account_id_tag: string;
    created_at: number;
    last_used_at: number | null;
    last_test_ok: number | null;
    last_test_at: number | null;
    last_test_error: string | null;
  } | null> {
    return await this.dbGet(`SELECT * FROM grvt_credentials WHERE user_id = ?`, [userId]);
  }

  async hasGrvtCredentials(userId: number): Promise<boolean> {
    const row = await this.dbGet(`SELECT 1 FROM grvt_credentials WHERE user_id = ?`, [userId]);
    return !!row;
  }

  async deleteGrvtCredentials(userId: number): Promise<void> {
    await this.dbRun(`DELETE FROM grvt_credentials WHERE user_id = ?`, [userId]);
  }

  async touchGrvtCredentialsLastUsed(userId: number): Promise<void> {
    await this.dbRun(
      `UPDATE grvt_credentials SET last_used_at = ? WHERE user_id = ?`,
      [Date.now(), userId]
    );
  }

  // ─── Multi-tenant: bot listing per user ────────────────────────

  async getBotsForUser(userId: number): Promise<GridBot[]> {
    return await this.dbAll(
      `SELECT * FROM grid_bots WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
  }

  async countActiveBotsForUser(userId: number): Promise<number> {
    const row = await this.dbGet(
      `SELECT COUNT(*) as c FROM grid_bots WHERE user_id = ? AND status IN ('running', 'paused')`,
      [userId]
    );
    return (row?.c as number) ?? 0;
  }

  // ─── Owner bootstrap ───────────────────────────────────────────
  // Idempotent. If users table is empty, creates user 1 from
  // OWNER_EMAIL + OWNER_INITIAL_PASSWORD env vars and backfills
  // every existing per-bot row to user_id=1. Skips silently if
  // any user already exists.
  async ownerBootstrap(params: {
    email: string;
    password_hash: string;
  }): Promise<{ created: boolean; userId: number }> {
    const existing = await this.countUsers();
    if (existing > 0) {
      const owner = await this.dbGet(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
      return { created: false, userId: owner?.id ?? 1 };
    }
    const userId = await this.createUser({
      email: params.email,
      password_hash: params.password_hash,
      is_admin: true,
    });
    // Backfill every per-bot row to this owner.
    const tables = [
      'grid_bots', 'grid_levels', 'orders', 'trades',
      'funding_history', 'daily_snapshots', 'fills_archive',
      'bot_cash_movements', 'paired_roundtrips',
    ];
    for (const t of tables) {
      await this.dbRun(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, [userId]);
    }
    console.log(`👤 Owner bootstrap: user ${userId} (${params.email}) created and backfilled`);
    return { created: true, userId };
  }

  /**
   * Cerrar conexión a database
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          console.error('❌ Error cerrando database:', err);
          reject(err);
        } else {
          console.log('📊 Database cerrada');
          resolve();
        }
      });
    });
  }
}

// Instancia singleton de la database
export const db = new GridBotDB();

export default db;