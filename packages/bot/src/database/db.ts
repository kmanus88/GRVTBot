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

    // Tabla: fills_archive - cache de fills procesados (sin bot_id, global)
    // Originally created ad-hoc by an emergency script. Now part of the schema
    // so fresh installs and migrations work correctly.
    await this.dbRun(`
      CREATE TABLE IF NOT EXISTS fills_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fill_id TEXT UNIQUE,
        event_time TEXT,
        is_buyer INTEGER,
        price REAL,
        size REAL,
        fee REAL,
        created_at TEXT
      )
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

    console.log('📋 Tablas creadas/verificadas');
  }

  // === CRUD para grid_bots ===

  /**
   * Crear nuevo grid bot
   */
  async createBot(params: Omit<GridBot, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    // Set original_investment_usdt = investment_usdt at creation. After
    // this point, investment_usdt may drift (compound, manual edits) but
    // the original is immutable so we always know the real cash deposit.
    const values = [
      params.pair, params.direction, params.leverage, params.lower_price,
      params.upper_price, params.num_grids, params.investment_usdt,
      params.investment_usdt,  // original_investment_usdt = investment_usdt
      params.grid_profit_usdt, params.trend_pnl_usdt, params.total_pnl_usdt,
      params.status, params.position_size, params.avg_entry_price,
      params.liquidation_price, params.params_json
    ];
    const sql = `
      INSERT INTO grid_bots (
        pair, direction, leverage, lower_price, upper_price, num_grids,
        investment_usdt, original_investment_usdt,
        grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
        status, position_size, avg_entry_price, liquidation_price, params_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   * The fills_archive table has no bot_id (global) — fine for v0 with a
   * single bot, will need a migration once multi-bot is live.
   */
  async insertFillArchive(params: {
    fill_id: string;
    event_time: string;
    is_buyer: number;
    price: number;
    size: number;
    fee: number;
    created_at: string;
  }): Promise<boolean> {
    const result = await this.dbRun(`
      INSERT OR IGNORE INTO fills_archive
        (fill_id, event_time, is_buyer, price, size, fee, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      params.fill_id,
      params.event_time,
      params.is_buyer,
      params.price,
      params.size,
      params.fee,
      params.created_at,
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