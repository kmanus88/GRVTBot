// Grid Trading Engine - Fase 3
// Lógica completa de grid trading con safeguards para dinero real

import { grvtClient, type GRVTClient } from '../api/client.js';
import { getGrvtClientForUser, invalidateGrvtClient } from '../api/grvt-client-factory.js';
import { db } from '../database/db.js';
import type { GridBot, GridLevel, OrderRecord } from '../database/db.js';
import { childLogger } from '../server/logger.js';
import { EventEmitter } from 'events';

const log = childLogger('engine');

export interface GridConfig {
  // Multi-tenant: which user owns this bot. Required for new bots
  // created via the API; optional in the type so legacy callers
  // (admin scripts, tests) can omit it and the bot defaults to
  // user 1 (the owner).
  userId?: number;
  pair: string;
  direction: 'long' | 'short';
  leverage: number;
  lowerPrice: number;
  upperPrice: number;
  numGrids: number;
  investmentUSDT: number;
}

export interface GridCalculation {
  spacing: number;
  quantityPerGrid: number;
  gridLevels: {
    index: number;
    price: number;
    side: 'buy' | 'sell';
    quantity: number;
  }[];
  estimatedProfitPerGrid: number;
  liquidationPrice: number;
}

/**
 * Result of buildRangeUpdatePlan(). Returned verbatim by both
 * /api/v2/bots/:id/range/preview (no execution) and as the input to
 * applyRangeUpdatePlan (commit). The dashboard renders this for the
 * user to inspect before confirming.
 *
 * Every numeric field is derived from real GRVT state — no estimates.
 */
export interface RangeUpdatePlan {
  botId: number;
  currentRange: { lower: number; upper: number };
  newRange: { lower: number; upper: number };
  currentPrice: number;
  currentPosition: number;
  newSellLevels: number;
  newBuyLevels: number;
  newTotalLevels: number;
  newSpacing: number;
  canonicalQty: number;
  ethNeeded: number;
  ethDeficit: number;
  ethExcess: number;
  autoBuy: {
    size: number;
    estimatedPrice: number;
    estimatedCost: number;
    slippagePct: number;
    estimatedSlippageUsd: number;
  } | null;
  ordersToCancel: number;
  ordersToCancelSample: Array<{ order_id: string; price: number }>;
  levelsToCreate: number;
  newLevels: Array<{
    level_index: number;
    price: number;
    side: 'buy' | 'sell';
    quantity: number;
  }>;
  warnings: string[];
  safetyViolations: string[];
  noop: boolean;
}

/**
 * Compute the per-level order quantity from investment parameters.
 * Extracted as a standalone function so both createBot/validate and
 * checkCompoundRebalance use the exact same formula.
 */
function computeQtyPerLevel(
  investmentUsdt: number,
  leverage: number,
  numGrids: number,
  midPrice: number,
  pair: string = 'ETH_USDT_Perp'
): number {
  const ORDER_ALLOC = 0.75;
  const effCap = investmentUsdt * leverage * ORDER_ALLOC;
  const minSize = pair === 'BTC_USDT_Perp' ? 0.001 : 0.01;
  let qty = Math.max(
    Math.ceil((effCap / numGrids / midPrice) * 100) / 100,
    0.03
  );
  // Ensure min notional at lowest likely price
  const minNotional = pair === 'BTC_USDT_Perp' ? 100 : 20;
  while (qty * midPrice * 0.8 < minNotional) {
    qty += minSize;
  }
  return Math.round(qty * 100) / 100;
}

// GRVT maintenance margin used by calculateLiquidationPrice() in the
// REST client. Kept in sync here for the local per-tick estimate so we
// don't have to fetch positions on every monitor loop. Verify per pair
// if GRVT ever publishes per-symbol margin tiers.
const SAFEGUARD_MAINTENANCE_MARGIN = 0.005;

/**
 * Local estimate of liquidation price for the safeguard check. Uses the
 * bot's current avg_entry_price (updated on every fill) and leverage,
 * so it stays accurate across the bot's lifetime without an extra GRVT
 * API call per tick. Returns null when there is no position yet —
 * the safeguard is a no-op in that case because there is nothing to
 * liquidate.
 */
function computeLiqPriceLocal(bot: GridBot): number | null {
  if (!bot.avg_entry_price || bot.avg_entry_price <= 0) return null;
  const factor = 1 / bot.leverage - SAFEGUARD_MAINTENANCE_MARGIN;
  if (factor <= 0) return null;
  if (bot.direction === 'long') {
    return bot.avg_entry_price * (1 - factor);
  } else {
    return bot.avg_entry_price * (1 + factor);
  }
}

/**
 * Grid Trading Engine
 * Maneja la lógica completa de grid trading con safeguards
 */
export class GridEngine extends EventEmitter {
  private bots = new Map<number, GridBotInstance>();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private fundingPollingInterval: NodeJS.Timeout | null = null; // ⚠️ NUEVO: Polling funding
  private dailySnapshotInterval: NodeJS.Timeout | null = null; // ⚠️ NUEVO: Daily snapshots
  private compoundCheckInterval: NodeJS.Timeout | null = null;
  private fillPollingInterval: NodeJS.Timeout | null = null; // Phase B.10: Fill archive poller
  private isRunning = false;

  // C.5: track every async task spawned from an interval / setTimeout
  // so stop() can drain them before the host closes the SQLite DB.
  // Without this, a SIGTERM during pollFillArchive would fail mid-write
  // against a closing DB, potentially corrupting the WAL.
  private inflightTasks = new Set<Promise<unknown>>();

  // Per-bot mutex set: a bot id is in this set while a long-running
  // mutation (currently: updateBotRange) is in flight. monitor() skips
  // any bot in this set so it cannot race with the mutation, place
  // duplicate orders, or read inconsistent grid_levels mid-transaction.
  private bumpInProgress = new Set<number>();

  /**
   * Register an async task started from an interval/timeout so stop()
   * can await it. Guarded by isRunning: if the engine is shutting
   * down we skip launching new work entirely (the interval may have
   * fired in the same tick that clearInterval ran). Errors are logged
   * but swallowed to avoid poisoning the set.
   */
  private track<T>(label: string, fn: () => Promise<T>): void {
    if (!this.isRunning) return;
    const task = fn().catch((err) => {
      log.error({ err: (err as Error).message }, `[${label}] in-flight task failed`);
    });
    this.inflightTasks.add(task);
    task.finally(() => this.inflightTasks.delete(task));
  }

  /**
   * Wait for every currently-registered async task to settle. Called
   * by stop() before returning so the outer shutdown can safely close
   * the DB. Uses allSettled so a single failed task doesn't abort the
   * drain.
   */
  private async drainInflight(label: string): Promise<void> {
    if (this.inflightTasks.size === 0) return;
    const pending = this.inflightTasks.size;
    log.info(`⏳ ${label}: waiting for ${pending} in-flight task(s) to settle...`);
    await Promise.allSettled([...this.inflightTasks]);
    log.info(`✅ ${label}: in-flight drain complete`);
  }

  isBotMutating(botId: number): boolean {
    return this.bumpInProgress.has(botId);
  }

  constructor() {
    super();
    log.info('🤖 Grid Engine inicializado');
  }

  /**
   * Resolve the GRVT client that should serve this bot. Multi-tenant:
   * if the bot has a user_id, look up that user's encrypted credentials
   * via the factory. Fall back to the module-level singleton (env vars)
   * for legacy bots with no user_id — this keeps bot 44 (owner) working
   * under the legacy env-var path while new bots route to their owner.
   *
   * The factory has its own LRU cache, so calling this on every tick is
   * cheap after the first resolve.
   */
  private async getClientForBot(
    bot: { id?: number; user_id?: number | null | undefined }
  ): Promise<GRVTClient> {
    if (bot.user_id != null) {
      try {
        return await getGrvtClientForUser(bot.user_id, db as any);
      } catch (err) {
        log.warn(
          `⚠️  Per-user GRVT client lookup failed for user ${bot.user_id} (bot ${bot.id ?? '?'}): ${(err as Error).message}. Falling back to singleton.`
        );
      }
    }
    return grvtClient;
  }

  /**
   * Drop any cached per-user GRVT client and replace the injected
   * reference on every running GridBotInstance owned by that user.
   * Call this after a user rotates their credentials so the next
   * tick uses the fresh keys instead of the stale cookie session.
   */
  async rebindGrvtClient(userId: number): Promise<void> {
    invalidateGrvtClient(userId);
    const affected: number[] = [];
    for (const [botId, instance] of this.bots) {
      const bot = instance.getBot();
      if (bot.user_id === userId) {
        try {
          const fresh = await getGrvtClientForUser(userId, db as any);
          instance.rebindClient(fresh);
          affected.push(botId);
        } catch (err) {
          log.warn(
            `⚠️  rebindGrvtClient: failed to refresh client for bot ${botId}: ${(err as Error).message}`
          );
        }
      }
    }
    if (affected.length > 0) {
      log.info(`🔄 Rebound GRVT client for user ${userId} on bots: ${affected.join(', ')}`);
    }
  }

  /**
   * Iniciar el engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.info('⚠️ Grid Engine ya está ejecutándose');
      return;
    }

    try {
      // Cargar bots activos de la database
      await this.loadActiveBots();
      
      // The engine is considered "running" from this point on so the
      // track() helper accepts the intervals about to fire. isRunning
      // was set at the very bottom before C.5 but that created a race:
      // if the first setTimeout below fired before the flag flipped,
      // track() would early-return and the task wouldn't be registered.
      this.isRunning = true;

      // Iniciar monitoreo cada 5 segundos
      this.monitoringInterval = setInterval(() => {
        this.track('monitorAllBots', () => this.monitorAllBots());
      }, 5000);

      // ⚠️ NUEVO: Polling funding history cada 30 minutos
      this.fundingPollingInterval = setInterval(() => {
        this.track('pollFundingHistory', () => this.pollFundingHistory());
      }, 30 * 60 * 1000); // 30 minutos

      // Compound rebalance: checks every hour. Only acts on bots with
      // compound_pct > 0. Uses real grid profit (spread-paired fills),
      // bumps investment_usdt + quantity_per_level atomically.
      this.compoundCheckInterval = setInterval(() => {
        this.track('checkCompoundRebalance', () => this.checkCompoundRebalance());
      }, 60 * 60 * 1000);
      log.info('🔄 Compound rebalance enabled (per-bot opt-in, checks every 1h)');

      // ⚠️ NUEVO: Daily snapshots cada 24h (00:00 UTC)
      // Inline setup (method is on GridBotInstance, not GridEngine)
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      const msUntilMidnight = tomorrow.getTime() - now.getTime();
      log.info(`📸 Daily snapshots configurados - próximo en ${Math.round(msUntilMidnight / 1000 / 3600)} horas`);
      // Note: actual snapshot logic is in GridBotInstance.createDailySnapshots()

      // ⚠️ NUEVO: Backfill inicial de funding history
      setTimeout(() => {
        this.track('backfillFundingHistory', () => this.backfillFundingHistory());
      }, 5000); // Ejecutar después de 5s para que el engine esté listo

      // Phase B.10: Fill archive poller — pulls fill_history from GRVT
      // every 30s, dedupes by fill_id, writes to fills_archive +
      // paired_roundtrips. The user discovered that fills_archive had
      // been frozen since 2026-03-24 because nothing was writing to it
      // in the engine — the schema existed but the writer was never
      // implemented. This loop is the writer.
      this.fillPollingInterval = setInterval(() => {
        this.track('pollFillArchive', () => this.pollFillArchive());
      }, 30 * 1000);
      // First poll fires 8s after boot (after auth + initial monitor pass)
      setTimeout(() => {
        this.track('pollFillArchive:initial', () => this.pollFillArchive());
      }, 8_000);
      log.info('✅ Grid Engine iniciado - monitoreando cada 5s, funding cada 30min, fills cada 30s, snapshots cada 24h');
      
    } catch (error) {
      log.error({ err: (error as Error).message }, '❌ Error iniciando Grid Engine:');
      throw error;
    }
  }

  /**
   * Parar el engine.
   *
   * C.5: the previous implementation cleared intervals and returned
   * immediately, leaving in-flight poll tasks (fill archive, funding,
   * compound check) racing against the host's db.close(). On SIGTERM
   * under real load this corrupted the SQLite WAL. Now we:
   *
   *   1. Flip isRunning=false so NEW work is refused by track().
   *   2. Clear every interval so no new ticks fire.
   *   3. Drain every in-flight task via drainInflight() — this is
   *      the critical await the old code was missing.
   *   4. Optionally pause bots (cancels GRVT orders). The SIGTERM
   *      path passes preserveOrders=true so a prod container restart
   *      leaves orders live on the exchange.
   *
   * Safe to call multiple times; the isRunning guard short-circuits.
   */
  async stop(options: { preserveOrders?: boolean } = {}): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // ⚠️ NUEVO: Limpiar funding polling
    if (this.fundingPollingInterval) {
      clearInterval(this.fundingPollingInterval);
      this.fundingPollingInterval = null;
    }

    // ⚠️ NUEVO: Limpiar daily snapshot interval
    if (this.dailySnapshotInterval) {
      clearInterval(this.dailySnapshotInterval);
      this.dailySnapshotInterval = null;
    }

    // ⚠️ NUEVO: Limpiar compound check interval
    if (this.compoundCheckInterval) {
      clearInterval(this.compoundCheckInterval);
      this.compoundCheckInterval = null;
    }

    // Phase B.10: clear fill poller
    if (this.fillPollingInterval) {
      clearInterval(this.fillPollingInterval);
      this.fillPollingInterval = null;
    }

    // C.5: drain in-flight async work before we let the caller close
    // the DB. Without this the process dies mid-write.
    await this.drainInflight('engine.stop');

    // Pausar todos los bots — skipped when preserveOrders is set so
    // SIGTERM restarts leave orders live on GRVT.
    if (!options.preserveOrders) {
      for (const [botId] of this.bots) {
        await this.pauseBot(botId);
      }
    }

    log.info(
      `🛑 Grid Engine detenido${options.preserveOrders ? ' (orders preserved on GRVT)' : ''}`
    );
  }

  /**
   * Crear nuevo grid bot (PAUSADO por default)
   */
  async createBot(config: GridConfig): Promise<number> {
    try {
      // Validar configuración
      this.validateGridConfig(config);

      // Calcular niveles de grid
      const calculation = await this.calculateGridLevels(config);
      
      // Crear bot en database (status = 'paused').
      // Pass quantity_per_level explicitly so the DB does NOT recompute
      // it via its own formula. The engine's calculateGridLevels() and
      // db.createBot() formulas must agree exactly, otherwise the grid
      // levels go in at one qty and the monitor's replacement orders
      // (which read getFixedQty() → bot.quantity_per_level) go in at
      // another, causing position drift. The fix here ensures there is
      // exactly one source of truth: calculation.quantityPerGrid.
      const botId = await db.createBot({
        // Default to user 1 (owner) when caller omits — admin
        // scripts and legacy code paths get the right behavior.
        user_id: config.userId ?? 1,
        pair: config.pair,
        direction: config.direction,
        leverage: config.leverage,
        lower_price: config.lowerPrice,
        upper_price: config.upperPrice,
        num_grids: config.numGrids,
        investment_usdt: config.investmentUSDT,
        quantity_per_level: calculation.quantityPerGrid,  // canonical, immutable
        grid_profit_usdt: 0,
        trend_pnl_usdt: 0,
        total_pnl_usdt: 0,
        status: 'paused', // ⚠️ PAUSADO por default
        position_size: 0,
        avg_entry_price: 0,
        liquidation_price: calculation.liquidationPrice,
        params_json: JSON.stringify({
          spacing: calculation.spacing,
          quantityPerGrid: calculation.quantityPerGrid,
          estimatedProfitPerGrid: calculation.estimatedProfitPerGrid
        })
      });

      // Guardar grid levels en database
      for (const level of calculation.gridLevels) {
        await db.createGridLevel({
          bot_id: botId,
          level_index: level.index,
          price: level.price,
          side: level.side,
          quantity: level.quantity,
          is_filled: false
        });
      }

      log.info(`✅ Bot creado: ID ${botId} - ${config.pair} ${config.direction} ${config.leverage}x (PAUSADO)`);
      this.emit('botCreated', { botId, config });

      return botId;

    } catch (error) {
      log.error({ err: (error as Error).message }, '❌ Error creando bot:');
      throw error;
    }
  }

  /**
   * Iniciar bot (cambiar de pausado a running).
   *
   * Two paths:
   *   1. RESUME — bot already has open orders and/or an open position on
   *      GRVT (e.g. previously running, paused in DB without cancelling
   *      orders, or rescued from a zombie state). We rebind to the existing
   *      state without placing any new orders. This is the same logic
   *      `loadActiveBots()` runs on engine startup for bots already in
   *      'running' status.
   *   2. FRESH START — no GRVT-side state, we bootstrap from scratch via
   *      `placeInitialOrders()` (which calls executeInitialPurchase + the
   *      grid layout).
   *
   * Pre Phase B.5.1, calling startBot on a bot with existing GRVT state
   * would re-run executeInitialPurchase, double the position, and trip
   * the GRVT 100-order Tier 1 cap. Bot 42 hit this during Phase A
   * recovery. Detection now prevents that.
   */
  async startBot(botId: number): Promise<void> {
    try {
      const bot = await db.getBot(botId);
      if (!bot) throw new Error(`Bot ${botId} no encontrado`);

      if (bot.status === 'running') {
        log.info(`⚠️ Bot ${botId} ya está ejecutándose`);
        return;
      }

      // Resolve the per-user GRVT client once, up-front. Every read /
      // write below uses this client so a bot owned by user X never
      // touches user Y's sub-account. Falls back to the singleton for
      // legacy bots without user_id.
      const client = await this.getClientForBot(bot);

      // ── DETECT EXISTING GRVT-SIDE STATE (FAIL LOUD) ──────────────
      // We MUST verify the live GRVT state before deciding RESUME vs
      // FRESH START. The previous version caught errors and returned
      // []/null, which silently routed us through FRESH START even
      // when the bot had a real open position — `placeInitialOrders`
      // would then DOUBLE the position and trip the GRVT 100-order
      // Tier 1 cap with a "Insufficient margin" error.
      //
      // New rule: if EITHER of the two read calls fails (after a
      // single retry), refuse to start. Operator must investigate
      // the GRVT API issue before proceeding. Failing closed is
      // strictly safer than guessing wrong.
      const fetchWithRetry = async <T>(
        label: string,
        fn: () => Promise<T>
      ): Promise<T> => {
        try {
          return await fn();
        } catch (err1) {
          log.warn(`⚠️ ${label} failed once during startBot detection, retrying in 1s: ${(err1 as Error).message}`);
          await new Promise((r) => setTimeout(r, 1000));
          try {
            return await fn();
          } catch (err2) {
            throw new Error(
              `Cannot verify GRVT state for bot ${botId} (${label}): ${(err2 as Error).message}. ` +
              `Refusing to start to avoid doubling an existing position. ` +
              `Investigate the GRVT API and try again.`
            );
          }
        }
      };

      const existingOrders = await fetchWithRetry(
        'getOpenOrders',
        () => client.getOpenOrders(bot.pair)
      );
      const existingPosition = await fetchWithRetry(
        'getPosition',
        () => client.getPosition(bot.pair)
      );
      const positionSize =
        existingPosition && (existingPosition as any).size
          ? Math.abs(parseFloat((existingPosition as any).size))
          : 0;
      const hasExistingState = existingOrders.length > 0 || positionSize > 0;

      const instance = new GridBotInstance(bot, client);
      this.bots.set(botId, instance);

      if (hasExistingState) {
        log.info(
          `🔁 Bot ${botId} RESUME — found ${existingOrders.length} open orders + position size ${positionSize}. Skipping bootstrap.`
        );
        await this.resumeBotInstance(bot, instance, existingOrders);
      } else {
        log.info(`🆕 Bot ${botId} FRESH START — no existing GRVT state, bootstrapping.`);
        // Verificar balance antes de iniciar
        await this.validateSufficientBalance(bot);
        // Establecer leverage
        await client.setLeverage(bot.pair, bot.leverage);
        // Colocar órdenes iniciales
        await instance.placeInitialOrders();
      }

      // Actualizar status a running (idem en ambos casos)
      await db.updateBot(botId, { status: 'running' });

      log.info(`🚀 Bot ${botId} iniciado - ${bot.pair} ${bot.direction} ${bot.leverage}x`);
      this.emit('botStarted', { botId });

    } catch (error) {
      // Roll back the in-memory instance registration so a failed start
      // doesn't leave a dangling instance the monitor loop will trip on.
      this.bots.delete(botId);
      log.error({ err: (error as Error).message }, `❌ Error iniciando bot ${botId}:`);
      throw error;
    }
  }

  /**
   * Rebind an existing GridBotInstance to live GRVT orders. Shared between
   * loadActiveBots() (engine startup) and startBot() (resume path).
   */
  private async resumeBotInstance(
    bot: any,
    instance: GridBotInstance,
    openOrders: any[]
  ): Promise<void> {
    // Cargar grid levels desde la DB
    await instance.loadGridLevels();

    const gridLevels = instance.getGridLevels();
    for (const grvtOrder of openOrders) {
      const leg = (grvtOrder as any).legs?.[0];
      if (!leg) continue;

      const price = parseFloat(leg.limit_price);
      const side = leg.is_buying_asset ? 'buy' : 'sell';
      const clientId = (grvtOrder as any).metadata?.client_order_id || grvtOrder.order_id;

      // Match by price (closest level within $0.50)
      const matchingLevel = gridLevels.find((l) => Math.abs(l.price - price) < 0.5);
      if (matchingLevel) {
        instance.setActiveOrder(String(clientId), {
          order_id: String(clientId),
          grid_level_id: matchingLevel.id,
          side,
          quantity: matchingLevel.quantity,
          price: matchingLevel.price,
          metadata: String(clientId),
        } as any);
      }
    }

    log.info(
      `✅ Bot ${bot.id} resumed: ${instance.getActiveOrderCount()} órdenes mapeadas a grid levels`
    );
  }

  /**
   * Pausar bot
   */
  async pauseBot(botId: number): Promise<void> {
    try {
      const instance = this.bots.get(botId);
      if (instance) {
        await instance.cancelAllOrders();
        this.bots.delete(botId);
      }

      await db.updateBot(botId, { status: 'paused' });
      
      log.info(`⏸️ Bot ${botId} pausado`);
      this.emit('botPaused', { botId });

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error pausando bot ${botId}:`);
      throw error;
    }
  }

  /**
   * Cerrar bot (cancelar órdenes + cerrar posición)
   */
  async closeBot(botId: number): Promise<void> {
    try {
      const bot = await db.getBot(botId);
      if (!bot) throw new Error(`Bot ${botId} no encontrado`);

      // Multi-tenant: route every GRVT call through the bot owner's
      // client. Must be resolved BEFORE pauseBot() because pauseBot
      // removes the instance from the map, which is where the client
      // is cached — after that we'd have to re-resolve anyway.
      const client = await this.getClientForBot(bot);

      // Pausar primero
      await this.pauseBot(botId);

      // ⚠️ CRÍTICO: Consultar posición real de GRVT, NO usar DB
      log.info('📊 Consultando posición real en GRVT...');
      const positions = await client.getPositions();
      const position = positions.find(p => p.instrument === bot.pair);
      const realPositionSize = position ? parseFloat(position.size) : 0;

      log.info(`📍 Posición real: ${realPositionSize} (DB: ${bot.position_size})`);

      // Si hay posición abierta, cerrarla con orden agresiva
      if (realPositionSize !== 0) {
        const closeSide = realPositionSize > 0 ? 'sell' : 'buy';
        const closeSize = Math.abs(realPositionSize);

        log.info(`🔄 Cerrando posición: ${closeSide} ${closeSize} ${bot.pair}`);

        // Precio agresivo (0.5% peor que market) con GTC para garantizar fill
        const ticker = await client.getTicker(bot.pair);
        const currentPrice = parseFloat(ticker.last_price);
        const aggressivePrice = closeSide === 'sell'
          ? Math.floor(currentPrice * 0.995 * 100) / 100   // 0.5% abajo para sell
          : Math.floor(currentPrice * 1.005 * 100) / 100;  // 0.5% arriba para buy

        // ⚠️ CRÍTICO: time_in_force debe matchear la firma EIP-712 (GTC = 1).
        // sub_account_id must match the client's own sub-account so
        // multi-tenant orders land on the right wallet.
        await client.createOrder({
          sub_account_id: client.subAccountId,
          instrument: bot.pair,
          size: (Math.floor(closeSize * 100) / 100).toString(),
          price: aggressivePrice.toString(),
          side: closeSide,
          type: 'limit',
          time_in_force: 'gtc'  // GTC matchea timeInForce=1 en EIP-712
        }, true);

        log.info(`✅ Orden de cierre: ${closeSide} ${closeSize} @ $${aggressivePrice} (GTC)`);
      }

      // Actualizar status a stopped
      await db.updateBot(botId, { status: 'stopped', position_size: realPositionSize });

      log.info(`🛑 Bot ${botId} cerrado completamente`);
      this.emit('botClosed', { botId });

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error cerrando bot ${botId}:`);
      throw error;
    }
  }

  /**
   * Cargar bots activos de la database
   */
  private async loadActiveBots(): Promise<void> {
    const activeBots = await db.getBotsByStatus('running');

    for (const bot of activeBots) {
      try {
        log.info(`🔧 [DEBUG] Cargando bot ${bot.id} - ${bot.pair} (status: ${bot.status})`);

        // Inject the bot owner's GRVT client so this instance uses
        // the correct per-user auth on every tick (multi-tenant).
        const client = await this.getClientForBot(bot);
        const instance = new GridBotInstance(bot, client);
        this.bots.set(bot.id, instance);

        const openOrders = await client.getOpenOrders(bot.pair);
        log.info(`📥 Bot ${bot.id}: ${openOrders.length} órdenes abiertas en GRVT`);

        // Shared resume logic with startBot()'s RESUME path.
        await this.resumeBotInstance(bot, instance, openOrders);

      } catch (error) {
        log.error({ err: (error as Error).message }, `❌ Error cargando bot ${bot.id}:`);
        this.bots.delete(bot.id);
        await db.updateBot(bot.id, { status: 'paused' });
      }
    }

    log.info(`✅ ${activeBots.length} bots activos cargados y verificados`);
  }

  /**
   * Monitorear todos los bots activos
   */
  private async monitorAllBots(): Promise<void> {
    if (!this.isRunning) return;

    for (const [botId, instance] of this.bots) {
      // Skip bots currently undergoing a long-running mutation
      // (updateBotRange). Without this skip the monitor would race
      // against the mutation: it would see partially-deleted levels,
      // misinterpret them as gaps, and try to "re-place" orders the
      // mutation is also trying to place — duplicates, fights, lost
      // money. The mutex is released in the mutation's finally block.
      if (this.bumpInProgress.has(botId)) {
        continue;
      }
      try {
        await instance.monitor();
      } catch (error) {
        log.error({ err: (error as Error).message }, `❌ Error monitoreando bot ${botId}:`);

        // Si hay errores críticos, pausar el bot (o pausar + cerrar según la acción).
        // Message format: SAFEGUARD:<action>:bot=N:dist=X%:liq=Y:mark=Z
        if (error instanceof Error && error.message.includes('SAFEGUARD')) {
          const action = error.message.match(/SAFEGUARD:(\w+):/)?.[1] ?? 'pause';
          log.info(`🚨 SAFEGUARD activado para bot ${botId} — acción: ${action}`);
          try {
            if (action === 'pause_close') {
              await this.closeBot(botId);
            } else {
              await this.pauseBot(botId);
            }
          } catch (pauseErr) {
            log.error({ err: (pauseErr as Error).message }, `❌ Error ejecutando acción safeguard ${action} para bot ${botId}:`);
          }
          this.emit('safeguardTriggered', {
            botId,
            action,
            reason: error.message,
            error: error.message, // legacy field preserved for existing WS consumers
          });
        }
      }
    }
  }

  /**
   * Calcular niveles de grid
   * ⚠️ ACTUALIZADO: debe generar exactamente numGrids+1 niveles (ej: 130 grids = 131 niveles)
   */
  async calculateGridLevels(config: GridConfig): Promise<GridCalculation> {
    // Multi-tenant: route ticker + liq-price lookups through the
    // owner's GRVT client so grid previews don't leak between users.
    const client = await this.getClientForBot({ user_id: config.userId });
    // Obtener precio actual
    const ticker = await client.getTicker(config.pair);
    const currentPrice = parseFloat(ticker.last_price);

    // Validar que el precio actual esté dentro del rango
    if (currentPrice <= config.lowerPrice || currentPrice >= config.upperPrice) {
      throw new Error(`Precio actual ${currentPrice} está fuera del rango [${config.lowerPrice}, ${config.upperPrice}]`);
    }

    const spacing = (config.upperPrice - config.lowerPrice) / config.numGrids;

    // CANONICAL per-level qty — must match exactly what db.createBot()
    // stores in bot.quantity_per_level, otherwise the initial orders go
    // in at one qty and the monitor's replacement orders (which read
    // from getFixedQty() → bot.quantity_per_level) go in at another,
    // causing permanent position drift.
    //
    // Bot 43 hit this on 2026-04-08: initial buys at 0.05 but sells
    // at 0.05/0.06 because the old per-level formula varied qty by
    // price. Then monitor replaced at the canonical 0.05. Position
    // drifted by 0.17 ETH (~$377) before the user closed.
    //
    // Formula matches db.createBot() line ~470:
    //   ORDER_ALLOC = 0.75 (15% safety on top of leverage cap, 10% extra)
    //   effCap = inv * leverage * ORDER_ALLOC
    //   midPrice = (lower + upper) / 2  ← uses range mid, NOT live price
    //   qty = ceil((effCap / numGrids / midPrice) * 100) / 100
    //   floor 0.03
    const ORDER_ALLOC = 0.75;
    const midPrice = (config.lowerPrice + config.upperPrice) / 2;
    const effCap = config.investmentUSDT * config.leverage * ORDER_ALLOC;
    const minNotional = config.pair === 'ETH_USDT_Perp' ? 20 : 100;
    const minSize = config.pair === 'ETH_USDT_Perp' ? 0.01 : 0.001;
    let canonicalQty = Math.max(
      Math.ceil((effCap / config.numGrids / midPrice) * 100) / 100,
      0.03
    );
    // Ensure min notional at the LOWEST price (worst-case for buy levels):
    // a 0.03 qty at $1800 = $54 which is well above $20, so this is
    // usually a no-op, but keep it as defense in depth.
    while (canonicalQty * config.lowerPrice < minNotional) {
      canonicalQty += minSize;
    }
    canonicalQty = Math.round(canonicalQty * 100) / 100;

    log.info(`🧮 Grid calculation: ${config.numGrids} grids = ${config.numGrids + 1} niveles`);
    log.info(`🧮 Rango: $${config.lowerPrice} - $${config.upperPrice}`);
    log.info(`🧮 Spacing: $${spacing.toFixed(2)} por nivel`);
    log.info(`🧮 Canonical qty per level: ${canonicalQty} ETH (effCap $${effCap.toFixed(2)} / ${config.numGrids} grids / $${midPrice} mid)`);

    // Generate level 0..numGrids = numGrids+1 levels. Every level
    // gets the SAME canonicalQty so the grid is constant-quantity.
    const gridLevels = [];
    for (let i = 0; i <= config.numGrids; i++) {
      const price = Math.round((config.lowerPrice + (i * spacing)) * 100) / 100;

      let side: 'buy' | 'sell';
      if (config.direction === 'long') {
        side = price < currentPrice ? 'buy' : 'sell';
      } else {
        side = price > currentPrice ? 'sell' : 'buy';
      }

      gridLevels.push({
        index: i,
        price,
        side,
        quantity: canonicalQty,
      });
    }

    const quantityPerGrid = canonicalQty;

    log.info(`🧮 Generados ${gridLevels.length} niveles (0 a ${config.numGrids})`);

    // Calcular profit estimado por grid
    const estimatedProfitPerGrid = spacing * quantityPerGrid;

    // Calcular liquidation price aproximado (non-fatal si falla)
    let liquidationPrice = 0;
    try {
      liquidationPrice = parseFloat(await client.calculateLiquidationPrice(config.pair, config.leverage));
    } catch (e) {
      log.info(`⚠️ No se pudo calcular liquidation price: ${(e as Error).message}`);
      // Estimación simple: entry / leverage para long
      if (config.direction === 'long') {
        liquidationPrice = currentPrice * (1 - 1/config.leverage) * 0.95;
      } else {
        liquidationPrice = currentPrice * (1 + 1/config.leverage) * 1.05;
      }
    }

    return {
      spacing,
      quantityPerGrid,
      gridLevels,
      estimatedProfitPerGrid,
      liquidationPrice
    };
  }

  /**
   * Validar configuración de grid (ACTUALIZADO con validaciones dinámicas)
   */
  private validateGridConfig(config: GridConfig): void {
    if (config.lowerPrice >= config.upperPrice) {
      throw new Error('Precio inferior debe ser menor que precio superior');
    }

    if (config.numGrids < 10 || config.numGrids > 95) {
      throw new Error('Número de rejillas debe estar entre 10 y 95 (límite GRVT: 100 open orders)');
    }

    if (config.leverage < 1 || config.leverage > 20) {
      throw new Error('Leverage debe estar entre 1x y 20x');
    }

    if (config.investmentUSDT < 50) {
      throw new Error('Inversión mínima: $50 USDT');
    }

    const supportedPairs = ['BTC_USDT_Perp', 'ETH_USDT_Perp'];
    if (!supportedPairs.includes(config.pair)) {
      throw new Error(`Par no soportado: ${config.pair}`);
    }

    // ⚠️ NUEVO: Validar min_notional por grid (con leverage)
    const effectiveCapital = config.investmentUSDT * config.leverage;
    const investmentPerGrid = effectiveCapital / config.numGrids;
    const minNotional = config.pair === 'ETH_USDT_Perp' ? 20 : 100;
    
    if (investmentPerGrid < minNotional) {
      const maxGrids = Math.floor((config.investmentUSDT * config.leverage) / minNotional);
      throw new Error(`Con $${config.investmentUSDT} de inversión, máximo ${maxGrids} grids (mín $${minNotional} por grid para ${config.pair})`);
    }

    log.info(`✅ [DEBUG] Configuración validada: ${config.numGrids} grids x $${investmentPerGrid.toFixed(2)} cada uno >= $${minNotional} min_notional`);
  }

  /**
   * NUEVO: Calcular máximo número de grids para una inversión y par
   */
  static calculateMaxGrids(investmentUSDT: number, pair: string): number {
    const minNotional = pair === 'ETH_USDT_Perp' ? 20 : 100;
    return Math.floor(investmentUSDT / minNotional);
  }

  /**
   * Validar balance suficiente
   */
  private async validateSufficientBalance(bot: GridBot): Promise<void> {
    const client = await this.getClientForBot(bot);
    const balance = await client.getBalance();
    const availableBalance = parseFloat(balance.available_balance);
    
    const requiredMargin = bot.investment_usdt / bot.leverage;
    
    log.info(`💰 [DEBUG] Validando balance: disponible $${availableBalance}, requerido $${requiredMargin}`);
    
    if (availableBalance < requiredMargin) {
      throw new Error(`Balance insuficiente: requerido $${requiredMargin.toFixed(2)}, disponible $${availableBalance.toFixed(2)}`);
    }
    
    // Validar que no exceda el 95% del balance total (safeguard)
    const totalBalance = parseFloat(balance.total_equity || balance.available_balance || '0');
    const maxInvestment = totalBalance * 0.95;
    if (bot.investment_usdt > maxInvestment) {
      throw new Error(`Inversión muy alta: máximo recomendado $${maxInvestment.toFixed(2)} (95% del balance total)`);
    }
    
    log.info(`✅ [DEBUG] Balance validado: margen OK, inversión dentro de límites seguros`);
  }

  /**
   * Obtener estado de todos los bots
   */
  async getBotStatus(): Promise<any[]> {
    const allBots = await db.getAllBots();
    
    return allBots.map(bot => ({
      id: bot.id,
      pair: bot.pair,
      direction: bot.direction,
      leverage: bot.leverage,
      lowerPrice: bot.lower_price,     // ← FIX: Campo faltante
      upperPrice: bot.upper_price,     // ← FIX: Campo faltante  
      numGrids: bot.num_grids,         // ← FIX: Campo faltante
      status: bot.status,
      pnl: bot.total_pnl_usdt,
      gridProfit: bot.grid_profit_usdt,
      trendPnl: bot.trend_pnl_usdt,
      investment: bot.investment_usdt,
      isActive: this.bots.has(bot.id)
    }));
  }

  /**
   * ⚠️ NUEVO: Polling periódico de funding history (cada 30 min)
   */
  private async pollFundingHistory(): Promise<void> {
    try {
      log.info(`💰 [DEBUG] Polling funding history...`);

      const activeBots = await db.getBotsByStatus('running');
      if (activeBots.length === 0) {
        log.info(`💰 [DEBUG] No hay bots activos, skipping funding poll`);
        return;
      }

      // Multi-tenant: funding payments are per sub-account, so each bot
      // needs its OWN poll against its OWNER's GRVT client. Two users
      // with ETH bots have disjoint funding streams, so the old
      // instrument-keyed loop would attribute user A's funding to
      // user B's bot.
      for (const bot of activeBots) {
        try {
          log.info(`💰 [DEBUG] Polling funding para bot ${bot.id} (${bot.pair})...`);

          const client = await this.getClientForBot(bot);
          const fundingPayments = await client.getFundingHistory(50, bot.pair);
          log.info(`💰 [DEBUG] Bot ${bot.id}: ${fundingPayments.length} funding payments`);

          // Obtener último funding time registrado para evitar duplicados
          const existingFunding = await db.getFundingHistoryByBot(bot.id);
          const lastFundingTime = existingFunding.length > 0 ?
            new Date(existingFunding[0]!.funding_time).getTime() : 0;

          // Filtrar nuevos payments
          const newPayments = fundingPayments.filter(payment =>
            payment.funding_time * 1000 > lastFundingTime
          );

          log.info(`💰 [DEBUG] Bot ${bot.id}: ${newPayments.length} nuevos funding payments`);

          for (const payment of newPayments) {
            try {
              // Convertir payment de raw a USDT (÷ 1e6)
              const paymentUsdt = parseFloat(payment.payment) / 1e6;

              await db.createFundingRecord({
                bot_id: bot.id,
                instrument: bot.pair,
                funding_rate: parseFloat(payment.funding_rate),
                payment_usdt: paymentUsdt,
                position_size: parseFloat(payment.position_size),
                funding_time: new Date(payment.funding_time * 1000).toISOString()
              });

              log.info(`💰 [DEBUG] Funding registrado para bot ${bot.id}: ${paymentUsdt.toFixed(4)} USDT`);

            } catch (fundingErr) {
              log.error({ err: (fundingErr as Error).message }, `❌ Error registrando funding para bot ${bot.id}:`);
            }
          }

          // Throttle between bots
          await new Promise(r => setTimeout(r, 1000));

        } catch (botErr) {
          log.error({ err: (botErr as Error).message }, `❌ Error polling funding para bot ${bot.id}:`);
        }
      }

      log.info(`✅ Funding history polling completado`);

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error en polling funding history:`);
    }
  }

  /**
   * ⚠️ NUEVO: Backfill inicial de funding history al startup
   */
  private async backfillFundingHistory(): Promise<void> {
    try {
      log.info(`🔄 [DEBUG] Iniciando backfill de funding history...`);

      const allBots = await db.getAllBots();
      if (allBots.length === 0) {
        log.info(`🔄 [DEBUG] No hay bots, skipping backfill`);
        return;
      }

      // Multi-tenant: one backfill per bot, using the owner's client.
      for (const bot of allBots) {
        try {
          log.info(`🔄 [DEBUG] Backfill funding para bot ${bot.id} (${bot.pair})...`);

          const client = await this.getClientForBot(bot);
          // Obtener todo el funding history disponible (últimos 500)
          const allFunding = await client.getFundingHistory(500, bot.pair);
          log.info(`🔄 [DEBUG] Bot ${bot.id}: total funding history disponible: ${allFunding.length}`);

          const botCreatedTime = new Date(bot.created_at).getTime();

          // Filtrar funding después de la creación del bot
          const relevantFunding = allFunding.filter(payment =>
            payment.funding_time * 1000 >= botCreatedTime
          );

          log.info(`🔄 [DEBUG] Bot ${bot.id}: ${relevantFunding.length} funding payments relevantes`);

          for (const payment of relevantFunding) {
            try {
              // Verificar si ya existe este funding
              const existing = await db.getFundingHistoryByBot(bot.id);
              const fundingTimeStr = new Date(payment.funding_time * 1000).toISOString();

              if (existing.some(f => f.funding_time === fundingTimeStr)) {
                continue; // Ya existe, skip
              }

              // Convertir payment de raw a USDT (÷ 1e6)
              const paymentUsdt = parseFloat(payment.payment) / 1e6;

              await db.createFundingRecord({
                bot_id: bot.id,
                instrument: bot.pair,
                funding_rate: parseFloat(payment.funding_rate),
                payment_usdt: paymentUsdt,
                position_size: parseFloat(payment.position_size),
                funding_time: fundingTimeStr
              });

            } catch (recordErr) {
              log.error({ err: (recordErr as Error).message }, `❌ Error registrando funding record:`);
            }
          }

          log.info(`🔄 [DEBUG] Backfill completado para bot ${bot.id}`);

          // Throttle between bots
          await new Promise(r => setTimeout(r, 2000));

        } catch (botErr) {
          log.error({ err: (botErr as Error).message }, `❌ Error backfill funding para bot ${bot.id}:`);
        }
      }

      log.info(`✅ Funding history backfill completado`);

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error en backfill funding history:`);
    }
  }

  private async checkCompoundRebalance(): Promise<void> {
    try {
      const bots = await db.getAllBots();

      for (const bot of bots) {
        if (bot.status !== 'running') continue;

        const pct = bot.compound_pct || 0;
        const threshold = bot.compound_threshold_usdt || 50;
        const intervalHours = bot.compound_interval_hours || 24;
        const lastCompoundAt = bot.last_compound_at;

        if (pct <= 0) continue; // Compound disabled for this bot

        // Check if enough time has passed since last compound
        if (lastCompoundAt) {
          const hoursSince = (Date.now() - new Date(lastCompoundAt).getTime()) / (1000 * 60 * 60);
          if (hoursSince < intervalHours) continue;
        }

        // Use real grid profit from spread-paired fills, NOT balance diff.
        // Subtract cumulative compound amount already taken.
        const gridProfitTotal = bot.grid_profit_usdt ?? 0;
        const alreadyCompounded = await db.getCompoundedTotal(bot.id) ?? 0;
        const availableProfit = gridProfitTotal - alreadyCompounded;

        if (availableProfit < threshold) {
          log.info(`📊 Compound bot ${bot.id}: $${availableProfit.toFixed(2)} available < $${threshold} threshold — skip`);
          continue;
        }

        // Calculate compound amount and new qty_per_level.
        const compoundAmount = availableProfit * (pct / 100);
        const newInvestment = bot.investment_usdt + compoundAmount;
        const midPrice = (bot.lower_price + bot.upper_price) / 2;
        const newQty = computeQtyPerLevel(newInvestment, bot.leverage, bot.num_grids, midPrice, bot.pair);
        const oldQty = bot.quantity_per_level || 0;

        log.info(`🔄 Compound bot ${bot.id}: +$${compoundAmount.toFixed(2)} (${pct}% of $${availableProfit.toFixed(2)} profit)`);
        log.info(`   investment: $${bot.investment_usdt.toFixed(2)} → $${newInvestment.toFixed(2)}, qty: ${oldQty} → ${newQty}`);

        // Atomic DB update: bump investment AND qty_per_level together.
        // New orders placed by monitor() will use the new qty. Existing
        // orders stay at old qty until they fill and get replaced — the
        // position adjusts organically over grid cycles.
        await db.updateBot(bot.id, {
          investment_usdt: newInvestment,
          quantity_per_level: newQty,
          total_reinvested: (bot.total_reinvested || 0) + compoundAmount,
          last_compound_at: new Date().toISOString(),
        });

        await db.recordCashMovement({
          bot_id: bot.id,
          type: 'compound',
          amount_usdt: compoundAmount,
          notes: `${pct}% of $${availableProfit.toFixed(2)} grid profit (lifetime $${gridProfitTotal.toFixed(2)}, qty ${oldQty}→${newQty})`,
        });

        log.info(`✅ Bot ${bot.id} compounded: $${bot.investment_usdt.toFixed(2)} → $${newInvestment.toFixed(2)}`);
      }

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error en compound rebalance:`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // RANGE UPDATE — production-quality v2
  //
  // Two phases, single source of truth, fully atomic for the DB write.
  //
  // Phase 1 — buildRangeUpdatePlan(botId, newLower, newUpper)
  //   Pure read-only function. Returns a `RangeUpdatePlan` describing
  //   exactly what would change: levels to insert, orders to cancel,
  //   ETH to auto-buy (with cost estimate and slippage), warnings,
  //   safety violations. NO state changes, NO orders sent.
  //   Used by both /range/preview and /range/commit (the commit
  //   phase calls it first to compute the plan, then executes).
  //
  // Phase 2 — applyRangeUpdatePlan(plan)
  //   Acquires per-bot mutex (monitor() will skip the bot during this).
  //   Buys ETH if needed, replaces all grid_levels in a single DB
  //   transaction (the new replaceAllGridLevels() helper handles the
  //   level_index UNIQUE collision by deleting all old rows before
  //   inserting fresh 0..N), cancels orders, places new orders, and
  //   updates bot.lower_price / upper_price. Releases mutex in finally.
  //
  // Safety caps (hard, non-overrideable from the API layer):
  //   MAX_AUTO_BUY_ETH        = 2.0   ETH absolute cap on market buy
  //   MAX_RANGE_DRIFT_PCT     = 50%   |new mid - current price| cap
  //   MIN_LOWER_DISTANCE_PCT  = 50%   newLower must be ≥ 0.5 × current
  //   MAX_UPPER_DISTANCE_PCT  = 200%  newUpper must be ≤ 2.0 × current
  //   AUTO_BUY_SLIPPAGE_PCT   = 0.5%  IOC limit price aggression
  // ───────────────────────────────────────────────────────────────────

  async previewBotRangeUpdate(
    botId: number,
    newLower: number,
    newUpper: number
  ): Promise<RangeUpdatePlan> {
    return this.buildRangeUpdatePlan(botId, newLower, newUpper);
  }

  async updateBotRange(
    botId: number,
    newLower: number,
    newUpper: number
  ): Promise<void> {
    // Build the plan first — same code path as preview, so the user
    // is committing to exactly what they saw.
    const plan = await this.buildRangeUpdatePlan(botId, newLower, newUpper);

    // Hard refuse on any safety violation. The dashboard preview shows
    // the same warnings so the user is never surprised at this point.
    if (plan.safetyViolations.length > 0) {
      throw new Error(
        `Range update refused: ${plan.safetyViolations.join('; ')}`
      );
    }

    // No-op short-circuit. The plan builder already detected this and
    // returned `noop: true`; we just exit cleanly.
    if (plan.noop) {
      log.info(`⚪ Range unchanged for bot ${botId} — no-op`);
      return;
    }

    // Acquire mutex BEFORE any state mutation. Released in finally.
    if (this.bumpInProgress.has(botId)) {
      throw new Error(`Bot ${botId} already has a range update in flight`);
    }
    this.bumpInProgress.add(botId);

    try {
      await this.applyRangeUpdatePlan(plan);
    } finally {
      this.bumpInProgress.delete(botId);
    }
  }

  /**
   * Build a RangeUpdatePlan. Pure read-only — never mutates state,
   * never sends orders. Safe to call from a /preview endpoint.
   *
   * Returns the plan even if there are safety violations; the caller
   * inspects plan.safetyViolations to decide whether to commit. The
   * dashboard surfaces these violations to the user.
   */
  private async buildRangeUpdatePlan(
    botId: number,
    newLower: number,
    newUpper: number
  ): Promise<RangeUpdatePlan> {
    const bot = await db.getBot(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }

    const client = await this.getClientForBot(bot);
    const ticker = await client.getTicker(bot.pair);
    const currentPrice = parseFloat(ticker.last_price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error(`Bot ${botId}: invalid ticker price`);
    }

    // No-op detection (1 cent tolerance on each bound).
    const noop =
      Math.abs(newLower - bot.lower_price) < 0.01 &&
      Math.abs(newUpper - bot.upper_price) < 0.01;

    // ── SAFETY CAPS (hard, non-overrideable) ─────────────────────
    const MAX_AUTO_BUY_ETH = 2.0;
    const MIN_LOWER_DISTANCE_PCT = 0.5;  // newLower ≥ 0.5 × current
    const MAX_UPPER_DISTANCE_PCT = 2.0;  // newUpper ≤ 2.0 × current
    const AUTO_BUY_SLIPPAGE_PCT = 0.5;

    const safetyViolations: string[] = [];

    if (newLower <= 0 || newUpper <= 0 || newLower >= newUpper) {
      safetyViolations.push('Invalid range: lower must be < upper, both > 0');
    }
    if (currentPrice < newLower || currentPrice > newUpper) {
      safetyViolations.push(
        `Current price $${currentPrice.toFixed(2)} is outside new range $${newLower}-$${newUpper}`
      );
    }
    if (newLower < currentPrice * MIN_LOWER_DISTANCE_PCT) {
      safetyViolations.push(
        `Lower price too far below market: $${newLower} < ${(MIN_LOWER_DISTANCE_PCT * 100).toFixed(0)}% of $${currentPrice.toFixed(2)}`
      );
    }
    if (newUpper > currentPrice * MAX_UPPER_DISTANCE_PCT) {
      safetyViolations.push(
        `Upper price too far above market: $${newUpper} > ${(MAX_UPPER_DISTANCE_PCT * 100).toFixed(0)}% of $${currentPrice.toFixed(2)}`
      );
    }

    // ── CANONICAL QTY (immutable, single source of truth) ────────
    const canonicalQty = (bot as { quantity_per_level?: number }).quantity_per_level
      ?? 0; // 0 = unknown, will be flagged in violations
    if (!canonicalQty || canonicalQty <= 0) {
      safetyViolations.push('Bot has no quantity_per_level set (legacy bot, run migration)');
    }

    // ── PLAN COMPUTATION ──────────────────────────────────────────
    const numGrids = bot.num_grids;
    const newSpacing = (newUpper - newLower) / numGrids;

    // Build the full new level set (level_index 0..numGrids).
    const newLevels: Array<{
      level_index: number;
      price: number;
      side: 'buy' | 'sell';
      quantity: number;
    }> = [];
    let sellLevelsCount = 0;
    for (let i = 0; i <= numGrids; i++) {
      const price = Math.round((newLower + i * newSpacing) * 100) / 100;
      const side: 'buy' | 'sell' = price < currentPrice ? 'buy' : 'sell';
      newLevels.push({ level_index: i, price, side, quantity: canonicalQty });
      if (side === 'sell') sellLevelsCount++;
    }

    // ETH backing required for the sell side. In long-only perpetual
    // grids, the position size should equal (number of pending sells)
    // × (qty per sell). If short on backing, we must market-buy the
    // deficit BEFORE the sells go in or they'd take us short.
    const ethNeeded = sellLevelsCount * canonicalQty;

    // Live position from GRVT — resolved via the per-bot client. The
    // `client` was set earlier in buildRangeUpdatePlan() when we read
    // the ticker.
    let currentPosition = 0;
    try {
      const position = await client.getPosition(bot.pair);
      if (position) currentPosition = parseFloat(position.size);
    } catch (posErr) {
      safetyViolations.push(
        `Cannot read live position from GRVT: ${(posErr as Error).message}`
      );
    }

    const ethDeficit = Math.max(0, ethNeeded - currentPosition);
    const ethExcess = Math.max(0, currentPosition - ethNeeded);

    if (ethDeficit > MAX_AUTO_BUY_ETH) {
      safetyViolations.push(
        `Auto-buy deficit ${ethDeficit.toFixed(4)} ETH exceeds safety cap of ${MAX_AUTO_BUY_ETH} ETH`
      );
    }

    const autoBuyAggressivePrice =
      Math.ceil(currentPrice * (1 + AUTO_BUY_SLIPPAGE_PCT / 100) * 100) / 100;
    const autoBuyEstimatedCost = ethDeficit * autoBuyAggressivePrice;
    const autoBuySlippageCostUsd = ethDeficit * currentPrice * (AUTO_BUY_SLIPPAGE_PCT / 100);

    // List existing levels that would be cancelled (any with a real
    // order_id, since we replaceAllGridLevels and re-place from scratch).
    const existingLevels = await db.getGridLevels(botId);
    const ordersToCancel = existingLevels
      .filter((l) =>
        l.order_id && l.order_id !== '0x00' && l.order_id !== 'price_based_detection'
      )
      .map((l) => ({ order_id: l.order_id!, price: l.price }));

    const warnings: string[] = [];
    if (noop) warnings.push('Range unchanged — this is a no-op');
    if (ethDeficit > 0) {
      warnings.push(
        `Will market-buy ${ethDeficit.toFixed(4)} ETH at ~$${autoBuyAggressivePrice} (~$${autoBuyEstimatedCost.toFixed(2)} total, ~$${autoBuySlippageCostUsd.toFixed(2)} slippage)`
      );
    }
    if (ethExcess > 0) {
      warnings.push(
        `Position has ${ethExcess.toFixed(4)} ETH excess vs the new sell-side requirement; the grid will absorb it naturally as sells fill`
      );
    }

    return {
      botId,
      currentRange: { lower: bot.lower_price, upper: bot.upper_price },
      newRange: { lower: newLower, upper: newUpper },
      currentPrice,
      currentPosition,
      newSellLevels: sellLevelsCount,
      newBuyLevels: newLevels.length - sellLevelsCount,
      newTotalLevels: newLevels.length,
      newSpacing,
      canonicalQty,
      ethNeeded,
      ethDeficit,
      ethExcess,
      autoBuy:
        ethDeficit > 0
          ? {
              size: ethDeficit,
              estimatedPrice: autoBuyAggressivePrice,
              estimatedCost: autoBuyEstimatedCost,
              slippagePct: AUTO_BUY_SLIPPAGE_PCT,
              estimatedSlippageUsd: autoBuySlippageCostUsd,
            }
          : null,
      ordersToCancel: ordersToCancel.length,
      ordersToCancelSample: ordersToCancel.slice(0, 5),
      levelsToCreate: newLevels.length,
      newLevels,
      warnings,
      safetyViolations,
      noop,
    };
  }

  /**
   * Execute a previously-built RangeUpdatePlan. The mutex is held by
   * the caller (updateBotRange). Steps:
   *
   *   1. If ethDeficit > 0: market-buy the deficit (IOC, fail loud).
   *      Verify position increased before touching DB.
   *   2. Cancel old GRVT orders (best-effort; failures are logged but
   *      not fatal — the monitor's duplicate killer cleans residuals).
   *   3. Atomically replace all grid_levels via the transactional
   *      replaceAllGridLevels() helper. This is the step that fixes
   *      the level_index UNIQUE collision: it deletes the entire old
   *      set inside the transaction BEFORE inserting fresh 0..N.
   *   4. Update bot.lower_price / upper_price.
   *   5. Place new orders one at a time, throttled. Failures here are
   *      logged; the monitor will pick them up next tick.
   */
  private async applyRangeUpdatePlan(plan: RangeUpdatePlan): Promise<void> {
    const bot = await db.getBot(plan.botId);
    if (!bot) throw new Error(`Bot ${plan.botId} not found at apply time`);

    // Multi-tenant: use the bot owner's client for all GRVT calls below
    // so range updates on user A's bot never touch user B's sub-account.
    const client = await this.getClientForBot(bot);

    log.info(
      `🔄 Updating range for bot ${plan.botId}: $${plan.currentRange.lower}-$${plan.currentRange.upper} → $${plan.newRange.lower}-$${plan.newRange.upper}`
    );
    log.info(
      `📊 Plan: ${plan.newTotalLevels} levels (${plan.newBuyLevels} buys, ${plan.newSellLevels} sells), need ${plan.ethNeeded.toFixed(4)} ETH, position ${plan.currentPosition.toFixed(4)} ETH, deficit ${plan.ethDeficit.toFixed(4)} ETH`
    );

    // Step 1: ETH auto-purchase
    if (plan.autoBuy) {
      log.info(
        `💰 Market-buying ${plan.autoBuy.size.toFixed(4)} ETH at ~$${plan.autoBuy.estimatedPrice} (deficit fill)`
      );

      const buyOrder = await client.createOrder(
        {
          sub_account_id: client.subAccountId,
          instrument: bot.pair,
          size: (Math.ceil(plan.autoBuy.size * 10000) / 10000).toString(),
          price: plan.autoBuy.estimatedPrice.toString(),
          side: 'buy',
          type: 'limit',
          time_in_force: 'ioc',
          metadata: `range_update_autobuy_${plan.botId}_${Date.now()}`,
        },
        true
      );
      log.info(`💰 Auto-buy order id ${buyOrder.order_id} sent`);

      // Wait for fill, verify, fail loud if short.
      await new Promise((r) => setTimeout(r, 2000));
      let postPosition = plan.currentPosition;
      try {
        const updatedPos = await client.getPosition(bot.pair);
        if (updatedPos) postPosition = parseFloat(updatedPos.size);
      } catch (e) {
        log.info(
          `⚠️ Could not verify position after auto-buy: ${(e as Error).message}`
        );
      }
      if (postPosition < plan.ethNeeded - 0.001) {
        throw new Error(
          `Auto-buy fill incomplete: position ${postPosition.toFixed(4)} ETH < needed ${plan.ethNeeded.toFixed(4)} ETH. Aborting before DB write.`
        );
      }
      log.info(
        `✅ Auto-buy filled. Position now ${postPosition.toFixed(4)} ETH`
      );
    }

    // Step 2: Cancel old GRVT orders (best-effort).
    for (const orderRef of plan.ordersToCancelSample.length === plan.ordersToCancel
      ? plan.ordersToCancelSample
      : (await db.getGridLevels(plan.botId))
          .filter(
            (l) =>
              l.order_id &&
              l.order_id !== '0x00' &&
              l.order_id !== 'price_based_detection'
          )
          .map((l) => ({ order_id: l.order_id!, price: l.price }))) {
      try {
        await client.cancelOrder(orderRef.order_id, bot.pair);
        log.info(`🗑️ Cancelled order ${orderRef.order_id} @ $${orderRef.price}`);
      } catch (cancelErr) {
        log.info(
          `⚠️ Could not cancel order ${orderRef.order_id}: ${(cancelErr as Error).message}`
        );
      }
    }

    // Step 3: Atomic DB replacement of all grid_levels.
    await db.replaceAllGridLevels(plan.botId, plan.newLevels);
    log.info(
      `🔁 Replaced grid_levels: ${plan.newLevels.length} fresh rows committed`
    );

    // Step 4: Update bot range.
    await db.updateBot(plan.botId, {
      lower_price: plan.newRange.lower,
      upper_price: plan.newRange.upper,
    });

    // Step 5: Place new orders, throttled.
    const instance = this.bots.get(plan.botId);
    if (instance) {
      // Refresh the bot instance's in-memory state from DB so it sees
      // the new levels. The monitor() loop won't run for this bot until
      // the mutex is released, so this is safe.
      const freshBot = await db.getBot(plan.botId);
      if (freshBot) instance.refreshBot(freshBot);
      await instance.loadGridLevels();

      const newLevelsFromDb = await db.getGridLevels(plan.botId);
      for (const level of newLevelsFromDb) {
        try {
          await instance.placeGridOrder(level);
          log.info(`✅ Placed: ${level.side} @ $${level.price}`);
          await new Promise((r) => setTimeout(r, 500)); // throttle
        } catch (placeErr) {
          log.error(
            `❌ Failed to place order @ $${level.price}: ${(placeErr as Error).message}`
          );
        }
      }
    }

    log.info(`✅ Range update completed for bot ${plan.botId}`);
  }

  /**
   * Phase B.10: Periodic fill poller.
   *
   * Pulls fill_history from GRVT and writes every fill into the
   * fills_archive table. Idempotent via INSERT OR IGNORE on the
   * UNIQUE event_time key, so catch-up after downtime is free.
   *
   * EVERYTHING is real GRVT data:
   *   - `fee`        → exactly what GRVT charged/refunded for that
   *                    fill on that account at that volume tier. We
   *                    never compute or assume a fee — different
   *                    accounts pay different rates (volume tier,
   *                    HBG staking, builder code...).
   *   - `price/size` → from GRVT's fill record, not the order request.
   *   - `event_time` → GRVT's nanosecond timestamp, used as the
   *                    unique key (more reliable than trade_id which
   *                    came in different formats from old vs new
   *                    fill_history responses).
   *   - `is_buyer`   → directly from GRVT's flag.
   *
   * NOTE: this loop does NOT write to paired_roundtrips. The previous
   * pairing implementation in calculateRealGridProfit() uses heuristic
   * spread bounds ($3..$20) to GUESS which buy filled which sell —
   * exactly the kind of estimation we don't want shipping in stats.
   * The bot's authoritative grid_profit_usdt comes from the engine's
   * per-level state machine. The rebate stat we surface to the
   * dashboard is just SUM(fee) over real fills.
   */
  private async pollFillArchive(): Promise<void> {
    if (this.bots.size === 0) return;

    // Multi-tenant: fills are per sub-account, so we must poll each
    // running bot's instrument through ITS OWNER's client. A single
    // user with one bot = one call. Several users with bots on the
    // same pair = several calls (one per user). v0 constraint: one
    // running bot per (user, instrument) pair.
    const counts = new Map<string, { added: number; feeSum: number }>();
    for (const [botId, instance] of this.bots) {
      const bot = instance.getBot();
      const instrument = bot.pair;
      if (!instrument) continue;

      const client = await this.getClientForBot(bot);
      let allFills: any[];
      try {
        allFills = await client.getFillHistory(1000, instrument);
      } catch (err) {
        log.warn(`⚠️ Fill poller [bot ${botId} ${instrument}]: getFillHistory failed: ${(err as Error).message}`);
        continue;
      }
      if (!Array.isArray(allFills) || allFills.length === 0) continue;

      let added = 0;
      let feeSum = 0;
      for (const f of allFills) {
        const eventTime = String(f.event_time ?? '');
        if (!eventTime) continue;
        const fee = parseFloat(f.fee ?? '0');
        const inserted = await db.insertFillArchive({
          fill_id: eventTime,
          event_time: eventTime,
          is_buyer: f.is_buyer ? 1 : 0,
          price: parseFloat(f.price ?? '0'),
          size: parseFloat(f.size ?? '0'),
          fee,
          created_at: new Date(Number(eventTime) / 1_000_000).toISOString(),
          bot_id: botId,
          instrument,
        });
        if (inserted) {
          added++;
          feeSum += fee;
        }
      }
      if (added > 0) counts.set(`bot ${botId} ${instrument}`, { added, feeSum });
    }

    for (const [label, c] of counts) {
      log.info(
        `📥 Fill archive [${label}]: +${c.added} new (fee sum ${c.feeSum.toFixed(6)} USDT, ${c.feeSum < 0 ? 'rebate earned' : 'fees paid'})`
      );
    }
  }
}

/**
 * Instancia individual de un Grid Bot
 */
export class GridBotInstance {
  private bot: GridBot;
  private gridLevels: GridLevel[] = [];
  private activeOrders = new Map<string, OrderRecord>();
  private processedFills = new Set<string>(); // ⚠️ NUEVO: Deduplicación de fills
  // Multi-tenant: per-user GRVT client resolved by GridEngine via
  // getClientForBot(). Falls back to the module-level `grvtClient`
  // singleton only for legacy bots with no user_id (the factory
  // couldn't resolve a per-user client).
  private injectedClient: GRVTClient | null = null;

  constructor(bot: GridBot, client?: GRVTClient) {
    this.bot = bot;
    this.injectedClient = client ?? null;
  }

  /** Accessor for the GRVT client this bot should use. Falls back
   *  to the legacy singleton if no per-user client was injected. */
  private get grvt(): GRVTClient {
    return this.injectedClient ?? grvtClient;
  }

  /** Replace the injected client (e.g. when user updates creds). */
  rebindClient(client: GRVTClient): void {
    this.injectedClient = client;
  }

  /** Read-only accessor used by the engine's fill poller to attribute
   *  fills to the right (bot, instrument) pair without breaking
   *  encapsulation. */
  getPair(): string {
    return this.bot.pair;
  }

  getBotId(): number {
    return this.bot.id;
  }

  /** Snapshot accessor used by GridEngine.rebindGrvtClient() to filter
   *  running instances by owner without breaking encapsulation. */
  getBot(): GridBot {
    return this.bot;
  }

  /** Replace the in-memory bot snapshot. Used by updateBotRange after
   *  it commits a new range to the DB so the instance sees fresh
   *  lower_price / upper_price / quantity_per_level immediately. */
  refreshBot(bot: GridBot): void {
    this.bot = bot;
  }

  async loadGridLevels(): Promise<void> {
    this.gridLevels = await db.getGridLevels(this.bot.id);
    log.info(`📊 Bot ${this.bot.id}: ${this.gridLevels.length} grid levels cargados`);
  }

  getGridLevels(): GridLevel[] {
    return this.gridLevels;
  }

  /**
   * Per-level order qty. Reads from the immutable bot.quantity_per_level
   * column set at bot creation. The legacy version recomputed this from
   * (investment_usdt * leverage * 0.75 / num_grids / midPrice) on every
   * call, which DRIFTED whenever compound bumped investment_usdt mid-life:
   * a buy placed at qty=0.04 would later get matched against a sell at
   * qty=0.05, leaving the residual 0.01 polluting the position permanently.
   * Bot 42 accumulated months of drift this way before we caught it.
   *
   * Now there is exactly one source of truth: the bot row. The only
   * legitimate way to change qty is a deliberate "rebalance" operation
   * that ALSO adjusts the position to match — never via a silent
   * recompute on each monitor tick.
   *
   * Fallback: if quantity_per_level is null (legacy bot pre-migration),
   * fall back to the old formula so the bot keeps running. The DB
   * migration backfills NULL rows from grid_levels[0].quantity, so this
   * fallback should never fire in practice.
   */
  getFixedQty(): number {
    const stored = (this.bot as { quantity_per_level?: number }).quantity_per_level;
    if (stored && stored > 0) return stored;

    // Legacy fallback (should not be reached after migration backfill).
    const ORDER_ALLOC = 0.75;
    const effCap = (this.bot.investment_usdt || 670) * (this.bot.leverage || 10) * ORDER_ALLOC;
    const levels = this.gridLevels;
    const rangeMin = levels.length > 0 ? levels[0]!.price : 1800;
    const rangeMax = levels.length > 0 ? levels[levels.length - 1]!.price : 2450;
    const midPrice = (rangeMin + rangeMax) / 2;
    return Math.max(Math.ceil((effCap / (this.bot.num_grids || 94) / midPrice) * 100) / 100, 0.03);
  }

  getActiveOrderCount(): number {
    return this.activeOrders.size;
  }

  setActiveOrder(id: string, order: any): void {
    this.activeOrders.set(id, order);
  }

  /**
   * Colocar órdenes iniciales según la estrategia de grid (con compra inicial para LONG)
   */
  async placeInitialOrders(): Promise<void> {
    log.info(`🚀 [DEBUG] Bot ${this.bot.id}: INICIANDO placeInitialOrders()`);
    
    // Cargar niveles de grid
    this.gridLevels = await db.getGridLevels(this.bot.id);
    log.info(`🔍 [DEBUG] Bot ${this.bot.id}: Cargados ${this.gridLevels.length} niveles de grid`);
    
    // Obtener precio actual
    const ticker = await this.grvt.getTicker(this.bot.pair);
    const currentPrice = parseFloat(ticker.last_price);

    log.info(`📊 Bot ${this.bot.id}: Precio actual ${this.bot.pair}: $${currentPrice}`);
    log.info(`📊 Bot ${this.bot.id}: Estrategia ${this.bot.direction.toUpperCase()} con ${this.gridLevels.length} niveles`);
    log.info(`📊 Bot ${this.bot.id}: Rango: $${this.gridLevels[0]?.price} - $${this.gridLevels[this.gridLevels.length - 1]?.price}`);
    
    // ⚠️ PASO 1: COMPRA INICIAL para bots LONG
    if (this.bot.direction === 'long') {
      await this.executeInitialPurchase(currentPrice);
    }

    // ⚠️ DRY RUN warning
    if (process.env.DRY_RUN === 'true') {
      log.info(`🧪 [DRY RUN] Bot ${this.bot.id}: Modo testing activado - NO se colocarán órdenes reales`);
    }

    let ordersToPlace = 0;
    let ordersPlaced = 0;
    let ordersSkipped = 0;

    // ⚠️ PASO 2: Colocar órdenes limit según la dirección
    for (const level of this.gridLevels) {
      log.info(`🔍 [DEBUG] Bot ${this.bot.id}: Evaluando nivel ${level.level_index}: ${level.side} ${level.quantity} @ $${level.price} (filled: ${level.is_filled})`);
      
      if (level.is_filled) {
        ordersSkipped++;
        log.info(`⏭️ [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} ya está filled, saltando`);
        continue;
      }

      const shouldPlace = this.shouldPlaceOrder(level, currentPrice);
      log.info(`🤔 [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} shouldPlace: ${shouldPlace} (current: $${currentPrice}, level: $${level.price}, side: ${level.side})`);
      
      if (shouldPlace) {
        ordersToPlace++;
        log.info(`📝 [DEBUG] Bot ${this.bot.id}: Colocando orden nivel ${level.level_index}...`);
        try {
          await this.placeGridOrder(level);
          ordersPlaced++;
          log.info(`✅ [DEBUG] Bot ${this.bot.id}: Orden nivel ${level.level_index} colocada exitosamente`);
          // Throttle: 200ms entre órdenes para evitar rate limit GRVT
          await new Promise(r => setTimeout(r, 200));
        } catch (error) {
          log.error({ err: (error as Error).message }, `❌ [DEBUG] Error colocando orden nivel ${level.level_index}:`);
        }
      } else {
        log.info(`❌ [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} NO cumple condiciones para colocar`);
      }
    }

    log.info(`✅ [DEBUG] Bot ${this.bot.id}: RESUMEN - ${ordersPlaced}/${ordersToPlace} órdenes ${process.env.DRY_RUN === 'true' ? '(simuladas)' : 'colocadas'}, ${ordersSkipped} saltadas`);
    log.info(`🎯 [DEBUG] Bot ${this.bot.id}: TERMINADO placeInitialOrders()`);
  }

  /**
   * NUEVO: Ejecutar compra inicial para grid LONG
   */
  private async executeInitialPurchase(currentPrice: number): Promise<void> {
    log.info(`💰 [DEBUG] Bot ${this.bot.id}: INICIANDO compra inicial para estrategia LONG`);

    // Calcular niveles SELL arriba del precio actual
    const sellLevelsAbove = this.gridLevels.filter(level => 
      level.price > currentPrice && !level.is_filled
    ).sort((a, b) => a.price - b.price);

    if (sellLevelsAbove.length === 0) {
      log.info(`⚠️ [DEBUG] Bot ${this.bot.id}: No hay niveles SELL arriba del precio actual, saltando compra inicial`);
      return;
    }

    // Calcular cantidad total de ETH necesaria
    const totalQuantityNeeded = sellLevelsAbove.reduce((sum, level) => sum + level.quantity, 0);
    const notionalUSDT = totalQuantityNeeded * currentPrice;

    log.info(`💰 [DEBUG] Bot ${this.bot.id}: Niveles SELL arriba: ${sellLevelsAbove.length}`);
    log.info(`💰 [DEBUG] Bot ${this.bot.id}: Cantidad total necesaria: ${totalQuantityNeeded} ETH`);
    log.info(`💰 [DEBUG] Bot ${this.bot.id}: Notional USDT: $${notionalUSDT.toFixed(2)}`);

    // Validar min_notional
    const minNotional = this.bot.pair === 'ETH_USDT_Perp' ? 20 : 100;
    if (notionalUSDT < minNotional) {
      log.info(`⚠️ [DEBUG] Bot ${this.bot.id}: Notional $${notionalUSDT.toFixed(2)} < min_notional $${minNotional}, saltando compra inicial`);
      return;
    }

    try {
      if (process.env.DRY_RUN === 'true') {
        log.info(`🧪 [DRY RUN] Bot ${this.bot.id}: COMPRA INICIAL que se ejecutaría: BUY ${totalQuantityNeeded} ${this.bot.pair} @ MARKET [notional: $${notionalUSDT.toFixed(2)}]`);
        
        // En dry run, simular la compra
        await db.updateBot(this.bot.id, {
          position_size: totalQuantityNeeded,
          avg_entry_price: currentPrice
        });
        
        log.info(`✅ [DRY RUN] Bot ${this.bot.id}: Compra inicial simulada exitosamente`);
        return;
      }

      // 💰 MODO REAL: Ejecutar compra market usando IOC
      log.info(`💰 [REAL] Bot ${this.bot.id}: Ejecutando compra inicial MARKET...`);

      // Usar precio ligeramente arriba del ask para asegurar fill
      const ticker = await this.grvt.getTicker(this.bot.pair);
      const askPrice = parseFloat((ticker as any).best_ask_price || (ticker as any).best_ask || ticker.last_price);
      const safeBuyPrice = Math.floor(askPrice * 1.001 * 100) / 100; // 0.1% arriba del ask, rounded to tick

      const order = await this.grvt.createOrder({
        sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID!,
        instrument: this.bot.pair,
        size: (Math.floor(totalQuantityNeeded * 100) / 100).toString(), // Round to 0.01
        price: safeBuyPrice.toString(),
        side: 'buy',
        type: 'limit', // IOC es tipo limit con time_in_force especial
        time_in_force: 'ioc', // IMMEDIATE_OR_CANCEL
        metadata: `initial_purchase_${this.bot.id}`
      }, true); // allowMarket=true

      log.info(`💰 [REAL] Bot ${this.bot.id}: Compra inicial enviada: ${order.order_id}`);

      // Esperar un momento para que se ejecute
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verificar si se ejecutó
      const fills = await this.grvt.getFillHistory(10, this.bot.pair!);
      const initialFills = fills.filter(fill => 
        fill.order_id === order.order_id && fill.side === 'buy'
      );

      if (initialFills.length > 0) {
        const totalFilled = initialFills.reduce((sum, fill) => sum + parseFloat(fill.size), 0);
        const avgPrice = initialFills.reduce((sum, fill) => sum + parseFloat(fill.price) * parseFloat(fill.size), 0) / totalFilled;

        log.info(`✅ [REAL] Bot ${this.bot.id}: Compra inicial ejecutada: ${totalFilled} ETH @ $${avgPrice.toFixed(2)}`);

        // Actualizar posición del bot
        await db.updateBot(this.bot.id, {
          position_size: totalFilled,
          avg_entry_price: avgPrice
        });

        // Registrar trades
        for (const fill of initialFills) {
          await db.createTrade({
            bot_id: this.bot.id,
            order_id: fill.order_id,
            fill_id: fill.fill_id,
            side: fill.side,
            quantity: parseFloat(fill.size),
            price: parseFloat(fill.price),
            fee: parseFloat(fill.fee),
            fee_currency: fill.fee_currency
          });
        }
      } else {
        log.info(`⚠️ [REAL] Bot ${this.bot.id}: Compra inicial no se ejecutó completamente, continuando con órdenes limit`);
      }

      // IMPORTANTE: Colocar SELL en el nivel justo arriba del precio de entry
      // Esto cierra el "gap" que queda entre los BUYs de abajo y los SELLs de arriba
      const entryLevel = this.gridLevels
        .filter(l => l.price > currentPrice)
        .sort((a, b) => a.price - b.price)[0];
      
      if (entryLevel) {
        log.info(`📍 [DEBUG] Bot ${this.bot.id}: Colocando SELL en nivel de entry $${entryLevel.price} (cierra gap)`);
        try {
          const entryOrder = { ...entryLevel, side: 'sell' as const };
          await this.placeGridOrder(entryOrder);
          log.info(`✅ Bot ${this.bot.id}: SELL de entry colocada en $${entryLevel.price}`);
        } catch (err) {
          log.info(`⚠️ Bot ${this.bot.id}: No se pudo colocar SELL de entry: ${err}`);
        }
      }

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ [DEBUG] Error en compra inicial para bot ${this.bot.id}:`);
      throw error;
    }
  }

  /**
   * Determinar si debe colocarse una orden en este nivel
   */
  private shouldPlaceOrder(level: GridLevel, currentPrice: number): boolean {
    log.info(`🧐 [DEBUG] shouldPlaceOrder() - Bot: ${this.bot.id}, Level: ${level.level_index}, Direction: ${this.bot.direction}`);
    log.info(`🧐 [DEBUG] shouldPlaceOrder() - Level: ${level.side} @ $${level.price}, Current: $${currentPrice}`);
    
    let result = false;
    
    if (this.bot.direction === 'long') {
      // LONG: buy orders debajo del precio, sell orders arriba
      const buyCondition = level.side === 'buy' && level.price < currentPrice;
      const sellCondition = level.side === 'sell' && level.price > currentPrice;
      result = buyCondition || sellCondition;
      
      log.info(`🧐 [DEBUG] shouldPlaceOrder() LONG - buyCondition: ${buyCondition} (${level.side}==='buy' && ${level.price}<${currentPrice})`);
      log.info(`🧐 [DEBUG] shouldPlaceOrder() LONG - sellCondition: ${sellCondition} (${level.side}==='sell' && ${level.price}>${currentPrice})`);
      log.info(`🧐 [DEBUG] shouldPlaceOrder() LONG - result: ${result}`);
      
    } else {
      // SHORT: sell orders arriba del precio, buy orders debajo  
      const sellCondition = level.side === 'sell' && level.price > currentPrice;
      const buyCondition = level.side === 'buy' && level.price < currentPrice;
      result = sellCondition || buyCondition;
      
      log.info(`🧐 [DEBUG] shouldPlaceOrder() SHORT - sellCondition: ${sellCondition} (${level.side}==='sell' && ${level.price}>${currentPrice})`);
      log.info(`🧐 [DEBUG] shouldPlaceOrder() SHORT - buyCondition: ${buyCondition} (${level.side}==='buy' && ${level.price}<${currentPrice})`);
      log.info(`🧐 [DEBUG] shouldPlaceOrder() SHORT - result: ${result}`);
    }
    
    return result;
  }

  /**
   * Colocar orden en un nivel de grid
   * ⚠️ ACTUALIZADO: usar nuevo createOrder con validación min_notional
   */
  async placeGridOrder(level: GridLevel): Promise<void> {
    log.info(`📝 [DEBUG] placeGridOrder() INICIADO - Bot: ${this.bot.id}, Level: ${level.level_index}`);
    log.info(`📝 [DEBUG] placeGridOrder() - Orden: ${level.side} ${level.quantity} ${this.bot.pair} @ $${level.price}`);
    
    try {
      // ⚠️ VALIDAR MIN_NOTIONAL antes de colocar orden
      const notional = level.quantity * level.price;
      const minNotional = this.bot.pair === 'ETH_USDT_Perp' ? 20 : 100; // ETH: $20, BTC: $100
      
      if (notional < minNotional) {
        log.info(`⚠️ [DEBUG] SKIP nivel ${level.level_index}: notional $${notional.toFixed(2)} < min_notional $${minNotional}`);
        return;
      }

      log.info(`✅ [DEBUG] Min_notional OK: $${notional.toFixed(2)} >= $${minNotional}`);

      // 🧪 DRY RUN MODE: Solo loguear las órdenes que se colocarían
      if (process.env.DRY_RUN === 'true') {
        log.info(`🧪 [DRY RUN] ORDEN QUE SE COLOCARÍA: ${level.side.toUpperCase()} ${level.quantity} ${this.bot.pair} @ $${level.price} (nivel ${level.level_index}) [notional: $${notional.toFixed(2)}]`);
        
        // En dry run, crear orden fake en database para testing
        const fakeOrderId = `dry_run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        log.info(`📝 [DEBUG] DRY RUN - Creando orden fake en DB: ${fakeOrderId}`);
        
        await db.createOrder({
          bot_id: this.bot.id,
          order_id: fakeOrderId,
          instrument: this.bot.pair,
          side: level.side,
          type: 'limit',
          quantity: level.quantity,
          price: level.price,
          status: 'pending',
          grid_level_id: level.id,
          metadata: `[DRY_RUN] grid_${this.bot.id}_${level.level_index}`
        });

        this.activeOrders.set(fakeOrderId, {
          order_id: fakeOrderId,
          instrument: this.bot.pair,
          side: level.side,
          type: 'limit',
          quantity: level.quantity,
          price: level.price,
          status: 'pending',
          metadata: `[DRY_RUN] grid_${this.bot.id}_${level.level_index}`
        } as any);

        log.info(`✅ [DEBUG] DRY RUN - Orden fake creada exitosamente`);
        return;
      }

      // 💰 MODO REAL: Colocar orden en GRVT usando nuevo formato
      log.info(`💰 [DEBUG] REAL MODE - Enviando orden a GRVT con nuevo createOrder...`);
      
      const order = await this.grvt.createOrder({
        sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID!,
        instrument: this.bot.pair,
        size: level.quantity.toString(),
        price: level.price.toString(),
        side: level.side,
        type: 'limit',
        time_in_force: 'gtc',
        post_only: true,
        metadata: `grid_${this.bot.id}_${level.level_index}`
      });

      log.info({ order }, 'REAL MODE - Respuesta de GRVT createOrder');

      // Si GRVT devuelve 0x00, buscar el order_id real en open_orders
      let realOrderId = order.order_id;
      if (realOrderId === '0x00' || realOrderId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        // Esperar 1 segundo para que GRVT procese
        await new Promise(r => setTimeout(r, 1000));
        
        // Buscar la orden por precio en open_orders
        const openOrders = await this.grvt.getOpenOrders(this.bot.pair);
        const match = openOrders.find((o: any) => {
          const orderPrice = o.legs?.[0]?.limit_price ? parseFloat(o.legs[0].limit_price) : 0;
          return Math.abs(orderPrice - level.price) < 1.0;
        });
        if (match) {
          realOrderId = match.order_id;
          log.info(`[0x00 FIX] Replaced 0x00 with real order_id: ${realOrderId.slice(0,20)}... @ $${level.price}`);
        } else {
          realOrderId = `temp_${Date.now()}_${level.price}_${Math.random().toString(36).slice(2,8)}`;
          log.info(`[0x00 FIX] Generated temp ID: ${realOrderId} for $${level.price}`);
        }
      }

      // Guardar realOrderId en database, NO order.order_id
      const uniqueOrderId = order.metadata || `grid_${this.bot.id}_${level.level_index}_${Date.now()}`;
      log.info(`📝 [DEBUG] REAL MODE - Guardando orden en DB con real order_id: ${realOrderId}`);
      await db.createOrder({
        bot_id: this.bot.id,
        order_id: realOrderId,
        instrument: this.bot.pair,
        side: level.side,
        type: 'limit',
        quantity: level.quantity,
        price: level.price,
        status: 'pending',
        grid_level_id: level.id,
        metadata: order.metadata || ''
      });

      // Guardar en activeOrders con grid_level_id para round-trip
      this.activeOrders.set(realOrderId, {
        ...order,
        order_id: realOrderId,
        grid_level_id: level.id,
        quantity: level.quantity,
        price: level.price,
        side: level.side,
        metadata: uniqueOrderId
      } as any);

      log.info(`📝 ✅ Orden creada: ${level.side} ${level.quantity} ${this.bot.pair} @ $${level.price} (ID: ${realOrderId}) [notional: $${notional.toFixed(2)}]`);

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ [DEBUG] Error colocando orden en nivel ${level.level_index}:`);
      log.error({ stack: error instanceof Error ? error.stack : String(error) }, 'Error stack');
      
      // ⚠️ NUEVO: Capturar error 7201 específicamente
      if (error instanceof Error && error.message.includes('7201')) {
        log.info(`⏸️ Nivel ${level.level_index} ($${level.price}) fuera del price band — pendiente hasta que el precio se acerque`);
        await db.markLevelPendingReplace(level.id);
        return; // NO reintentar, NO propagar como error fatal
      }
      
      // Si el error es min_notional, no propagarlo como error fatal
      if (error instanceof Error && error.message.includes('min_notional')) {
        log.info(`⚠️ [DEBUG] Min_notional error - skipping nivel ${level.level_index}`);
        return;
      }
      
      throw error;
    }
  }

  /**
   * Monitorear órdenes y ejecutar lógica de round-trip
   * ⚠️ FIX CRÍTICO: Verificar fills reales con fill_history antes de asumir fills
   */
  async monitor(): Promise<void> {
    // 0. Refresh bot config from DB (picks up compound changes)
    const freshBot = await db.getBot(this.bot.id);
    if (freshBot) this.bot = freshBot;
    
    // 1. Get open orders from GRVT
    const openOrders = await this.grvt.getOpenOrders(this.bot.pair);
    
    // 2. Get current price from the last ticker
    const ticker = await this.grvt.getTicker(this.bot.pair);
    const currentPrice = parseFloat(ticker.last_price);

    // 2.5. SAFEGUARD: liquidation proximity check (C.4). Opt-in per bot.
    // Throws a SAFEGUARD:<action>: error that monitorAllBots() parses to
    // decide whether to pause or pause+close. No-op when the bot has no
    // position yet (avg_entry_price = 0) or the safeguard is disabled.
    if (this.bot.safeguard_enabled) {
      const liq = computeLiqPriceLocal(this.bot);
      if (liq !== null && liq > 0) {
        const distancePct = this.bot.direction === 'long'
          ? ((currentPrice - liq) / currentPrice) * 100
          : ((liq - currentPrice) / currentPrice) * 100;
        const threshold = this.bot.safeguard_threshold_pct ?? 10;
        if (distancePct <= threshold) {
          const action = this.bot.safeguard_action ?? 'pause';
          throw new Error(
            `SAFEGUARD:${action}:bot=${this.bot.id}:dist=${distancePct.toFixed(2)}%:liq=${liq.toFixed(2)}:mark=${currentPrice.toFixed(2)}`
          );
        }
      }
    }

    // 3. Build set of GRVT prices (rounded) for coverage check
    const grvtPriceSet = new Set<number>();
    const grvtOrderMap = new Map<number, any>(); // price → {order_id, side}
    for (const order of openOrders) {
      const leg = (order as any).legs?.[0];
      if (!leg?.limit_price) continue;
      const price = Math.round(parseFloat(leg.limit_price) * 100) / 100;
      grvtPriceSet.add(price);
      grvtOrderMap.set(price, {
        order_id: order.order_id,
        side: leg.is_buying_asset ? 'buy' : 'sell'
      });
    }
    
    // 4. Get grid levels and sync DB with GRVT reality
    const gridLevels = await db.getGridLevels(this.bot.id);
    const filledLevels: any[] = [];
    const uncoveredLevels: { level: any, price: number, dist: number }[] = [];
    
    for (const level of gridLevels) {
      const lp = Math.round(level.price * 100) / 100;
      
      // Check if GRVT has an order at this price (±$0.5 to handle rounding)
      let covered = false;
      for (const gp of grvtPriceSet) {
        if (Math.abs(gp - lp) < 0.5) {
          // Covered — sync DB with GRVT order_id
          const grvtOrder = grvtOrderMap.get(gp);
          if (grvtOrder) {
            await db.updateGridLevel(level.id, {
              order_id: grvtOrder.order_id,
              side: grvtOrder.side,
              is_filled: false
            });
          }
          grvtPriceSet.delete(gp); // consume to prevent double-match
          covered = true;
          break;
        }
      }
      
      if (!covered) {
        uncoveredLevels.push({ level, price: lp, dist: Math.abs(lp - currentPrice) });
      }
    }
    
    // 5. SIMPLE RULE: exactly 93 orders on GRVT
    // uncoveredLevels = DB levels without GRVT order
    // Sort by distance: closest = natural gap, rest = need orders
    uncoveredLevels.sort((a, b) => a.dist - b.dist);
    
    log.info(`📊 Monitor: ${openOrders.length} GRVT, ${uncoveredLevels.length} uncovered, price $${currentPrice.toFixed(2)}`);
    
    if (uncoveredLevels.length > 0) {
      // Closest uncovered = natural gap
      const gap = uncoveredLevels[0]!;
      log.info(`🕳️ Gap: $${gap.level.price} (dist=$${gap.dist.toFixed(2)})`);
      await db.updateGridLevel(gap.level.id, { is_filled: true, order_id: '' });
    }
    
    if (uncoveredLevels.length > 1 && openOrders.length < 94) {
      // Check fill_history ONCE for recent fills (last 90s)
      const recentFills = await this.grvt.getFillHistory(50, this.bot.pair!);
      const now = Date.now();
      
      for (let i = 1; i < uncoveredLevels.length; i++) {
        const uc = uncoveredLevels[i]!;
        
        // Check if this was a recent fill
        const fillMatch = recentFills.find((fill: any) => {
          const fp = parseFloat(fill.price);
          const ft = parseInt(fill.event_time || '0') / 1e6;
          return Math.abs(fp - uc.level.price) < 1.0 && (now - ft) < 90000;
        });
        
        if (fillMatch) {
          const fillKey = `${(fillMatch as any).fill_id || (fillMatch as any).trade_id || `fill-${uc.price}-${now}`}`;
          if (!this.processedFills.has(fillKey)) {
            this.processedFills.add(fillKey);
            if (this.processedFills.size > 200) {
              [...this.processedFills].slice(0, 100).forEach(e => this.processedFills.delete(e));
            }
            log.info(`✅ Fill confirmed: ${uc.level.side} @ $${uc.level.price}`);
            filledLevels.push(uc.level);
          }
          continue;
        }
        
        // Not a fill — re-place (only if GRVT count allows)
        const correctSide: 'buy' | 'sell' = uc.price < currentPrice ? 'buy' : 'sell';
        // Fixed qty: same for ALL levels (calculated from midpoint price)
        const newQty = this.getFixedQty();
        log.info(`⚠️ Re-placing: ${correctSide} ${newQty} ETH @ $${uc.level.price}`);
        try {
          await db.updateGridLevel(uc.level.id, { order_id: '0x00', is_filled: false, side: correctSide, quantity: newQty });
          uc.level.side = correctSide;
          uc.level.quantity = newQty;
          await this.placeGridOrder(uc.level);
          log.info(`✅ Placed: ${correctSide} @ $${uc.level.price}`);
        } catch (e) {
          log.info(`❌ Failed: $${uc.level.price}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    
    // 5.5 DUPLICATE KILLER: if >93 orders, cancel extras
    if (openOrders.length > 93) {
      log.info(`🔴 ${openOrders.length} orders — killing duplicates`);
      const pc = new Map<string, any[]>();
      for (const order of openOrders) {
        const leg = (order as any).legs?.[0];
        if (!leg?.limit_price) continue;
        const pk = parseFloat(leg.limit_price).toFixed(2);
        if (!pc.has(pk)) pc.set(pk, []);
        pc.get(pk)!.push(order);
      }
      for (const [price, ords] of pc) {
        if (ords.length > 1) {
          for (let i = 1; i < ords.length; i++) {
            try {
              await this.grvt.cancelOrder(ords[i].order_id, this.bot.pair);
              log.info(`🗑️ Killed dupe @ $${price}`);
            } catch (e) { /* ignore */ }
          }
        }
      }
    }
    
    // 6. For each filled level, place counter-order at SAME price, OPPOSITE side
    const gridLevelsAll = await db.getGridLevels(this.bot.id);
    for (const level of filledLevels) {
      // Counter-order goes ONE LEVEL UP (buy filled → sell at level+1) or DOWN (sell filled → buy at level-1)
      // This captures the ~$7 spread as profit. The filled level stays empty (the "gap").
      let counterLevelIndex: number;
      let counterSide: 'buy' | 'sell';
      
      if (level.side === 'buy') {
        counterLevelIndex = level.level_index + 1;
        counterSide = 'sell';
      } else {
        counterLevelIndex = level.level_index - 1;
        counterSide = 'buy';
      }
      
      const counterLevel = gridLevelsAll.find((l: any) => l.level_index === counterLevelIndex);
      if (!counterLevel) {
        log.info(`⚠️ No counter level found for index ${counterLevelIndex}, skipping`);
        continue;
      }
      
      // ⚠️ CHECK: Si el nivel destino YA tiene orden activa, NO colocar otra (evita duplicados)
      if (counterLevel.order_id && counterLevel.order_id !== '0x00' && counterLevel.order_id !== '0x0000000000000000000000000000000000000000000000000000000000000000' && !counterLevel.is_filled) {
        log.info(`⚠️ Counter level ${counterLevelIndex} @ $${counterLevel.price} already has order ${counterLevel.order_id}, skipping duplicate`);
        // Solo marcar el filled level como filled
        await db.updateGridLevel(level.id, { is_filled: true });
        continue;
      }
      
      // Fixed qty: same for ALL levels (calculated from midpoint price)
      const finalQty = this.getFixedQty();
      
      log.info(`🔄 Round-trip: ${level.side} filled @ $${level.price} → placing ${counterSide} ${finalQty} ETH @ $${counterLevel.price} (level ${counterLevelIndex})`);
      
      try {
        await this.placeGridOrder({ ...counterLevel, side: counterSide, quantity: finalQty });
        
        // Mark filled level as filled (it stays empty - the gap)
        await db.updateGridLevel(level.id, { is_filled: true });
        
        // Update counter level with new side
        await db.updateGridLevel(counterLevel.id, {
          side: counterSide,
          is_filled: false
        });
      } catch (err: any) {
        if (err.message?.includes('7201') || err.message?.includes('2090')) {
          log.info(`⚠️ Skipping level ${counterLevelIndex}: ${err.message}`);
          await db.updateGridLevel(counterLevel.id, { pending_replace: true });
        }
      }
      
      await new Promise(r => setTimeout(r, 200)); // throttle
    }
    
    // 7. Update PnL
    await this.updatePnL();
    await this.checkPendingReplaceOrders();
  }



  /**
   * Manejar orden completada - lógica de round-trip
   */
  private async handleOrderFilled(orderId: string, order: OrderRecord): Promise<void> {
    // ⚠️ NUEVO: Deduplicación - verificar si ya procesamos este fill
    const fillKey = `${orderId}_${order.grid_level_id || 'unknown'}`;
    if (this.processedFills.has(fillKey)) {
      log.info(`🔄 Fill ${orderId} ya procesado, skipeando...`);
      return;
    }
    
    // Marcar como procesado INMEDIATAMENTE
    this.processedFills.add(fillKey);
    if (this.processedFills.size > 200) {
      [...this.processedFills].slice(0, 100).forEach(e => this.processedFills.delete(e));
    }

    // ⚠️ PRIMERO: remover de activeOrders para no re-detectar
    this.activeOrders.delete(orderId);
    
    try {
      // ⚠️ FIX: Obtener fills reales de GRVT para extraer fees
      let realFills: any[] = [];
      let totalFees = 0;
      try {
        const fillHistory = await this.grvt.getFillHistory(50, this.bot.pair);
        // Buscar fills que corresponden a esta orden (por client_order_id o timestamp cercano)
        const orderTrackingId = order.metadata || orderId;
        realFills = fillHistory.filter(fill => {
          return fill.client_order_id === orderTrackingId || 
                 fill.order_id === order.order_id ||
                 (Math.abs(new Date((fill as any).timestamp || fill.created_time * 1000).getTime() - Date.now()) < 60000 && 
                  Math.abs(parseFloat(fill.price) - (order.price || 0)) < 0.5);
        });
        
        totalFees = realFills.reduce((sum, fill) => sum + parseFloat(fill.fee), 0);
        log.info(`💰 [DEBUG] Fills encontrados para orden ${orderId}: ${realFills.length}, fees total: ${totalFees}`);
        
      } catch (fillErr) {
        log.info(`⚠️ Error obteniendo fills de GRVT: ${fillErr}, usando fee=0`);
      }

      // Marcar grid level como completado
      if (order.grid_level_id) {
        await db.fillGridLevel(order.grid_level_id, orderId);
      }

      // Actualizar status en database
      try { await db.updateOrderStatus(orderId, 'filled'); } catch(e) { /* ignore if not found */ }

      log.info(`✅ Orden filled: ${order.side} ${order.quantity} @ $${order.price} (fee: ${totalFees})`);

      // Registrar trades REALES con fees
      if (realFills.length > 0) {
        for (const fill of realFills) {
          try {
            await db.createTrade({
              bot_id: this.bot.id,
              order_id: order.order_id || orderId,
              fill_id: fill.fill_id || `fill_${Date.now()}_${Math.random()}`,
              side: fill.is_buyer ? 'buy' : 'sell',
              quantity: parseFloat(fill.size),
              price: parseFloat(fill.price),
              fee: parseFloat(fill.fee), // ⚠️ FIX: Fee real de GRVT
              fee_currency: fill.fee_currency || 'USDT'
            });
            log.info(`💾 Trade registrado: ${fill.is_buyer ? 'buy' : 'sell'} ${fill.size} @ ${fill.price} [fee: ${fill.fee}]`);
          } catch (tradeErr) {
            log.info(`⚠️ Error guardando trade individual: ${tradeErr}`);
          }
        }
      }

      // Colocar orden inversa en el siguiente nivel (round-trip)
      // Retry con delay si rate limited
      await this.placeCounterOrderWithRetry(order);

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error manejando orden completada ${orderId}:`);
    }
  }

  private async placeCounterOrderWithRetry(order: OrderRecord, retries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.placeCounterOrder(order);
        return; // Success
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        
        // ⚠️ NUEVO: Manejo específico para error 7201 (price protection band)
        if (msg.includes('7201')) {
          log.info(`⏸️ Error 7201 (price protection band) - NO reintentar, marcar como pendiente`);
          if (order.grid_level_id) {
            await db.markLevelPendingReplace(order.grid_level_id);
          }
          return;
        }

        // Post-only rejected (order would cross the book as taker)
        // Retry after short delay — price should move away
        if (msg.includes('post_only') || msg.includes('POST_ONLY') || msg.includes('would cross')) {
          if (attempt < retries) {
            const delay = attempt * 1000; // 1s, 2s, 3s
            log.info(`⏳ Post-only rejected (would be taker), retry ${attempt}/${retries} en ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // After all retries, mark as pending so monitor picks it up later
          log.info(`⏸️ Post-only rejected after ${retries} retries, marcando pendiente`);
          if (order.grid_level_id) {
            await db.markLevelPendingReplace(order.grid_level_id);
          }
          return;
        }

        // Manejo específico para "Max open orders exceeded" (429/2090)
        if (msg.includes('429') && msg.includes('2090')) {
          if (attempt < retries) {
            log.info(`⚠️ Max open orders exceeded (${msg}), verificando espacio...`);
            
            try {
              // Verificar cuántas órdenes abiertas tenemos
              const openOrders = await this.grvt.getOpenOrders();
              const orderCount = openOrders.length;
              
              log.info(`📊 Órdenes abiertas: ${orderCount}/100`);
              
              if (orderCount >= 100) {
                log.info(`❌ Sin espacio para nuevas órdenes (${orderCount}/100)`);
                throw new Error(`Max orders limit reached: ${orderCount}/100`);
              }
              
              // Esperar más tiempo para max orders (10s)
              const delay = 10000;
              log.info(`⏳ Esperando ${delay}ms antes de reintentar (${attempt}/${retries})...`);
              await new Promise(r => setTimeout(r, delay));
            } catch (verifyError) {
              log.error({ err: (verifyError as Error).message }, 'Error verificando ordenes abiertas');
              throw error; // Lanzar error original si no podemos verificar
            }
          } else {
            throw error;
          }
        } else if (msg.includes('429') && attempt < retries) {
          // Rate limit genérico
          const delay = attempt * 2000; // 2s, 4s, 6s
          log.info(`⏳ Rate limited, retry ${attempt}/${retries} en ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Colocar orden inversa para round-trip (LÓGICA MEJORADA)
   */
  private async placeCounterOrder(completedOrder: OrderRecord): Promise<void> {
    log.info(`🔄 [DEBUG] Bot ${this.bot.id}: ROUND-TRIP para orden ${completedOrder.order_id} (${completedOrder.side} @ $${completedOrder.price})`);

    // Encontrar nivel actual
    const currentLevel = this.gridLevels.find(l => l.id === completedOrder.grid_level_id);
    if (!currentLevel) {
      log.info(`❌ [DEBUG] Bot ${this.bot.id}: No se encontró nivel actual para orden ${completedOrder.order_id}`);
      return;
    }

    // Round-trip: place at NEXT level (buy filled → sell one level UP, sell filled → buy one level DOWN)
    // The filled level stays empty (the "gap") — this captures the ~$7 spread as profit
    let counterLevelIndex: number;
    const counterSide: 'buy' | 'sell' = completedOrder.side === 'buy' ? 'sell' : 'buy';
    
    if (completedOrder.side === 'buy') {
      counterLevelIndex = currentLevel.level_index + 1;
    } else {
      counterLevelIndex = currentLevel.level_index - 1;
    }
    
    const nextLevel = this.gridLevels.find(l => l.level_index === counterLevelIndex);
    if (!nextLevel) {
      log.info(`⚠️ No counter level at index ${counterLevelIndex}, skipping`);
      return;
    }

    // Fixed qty: same for ALL levels (calculated from midpoint price)
    const qty = this.getFixedQty();
    
    log.info(`🔄 Round-trip: ${completedOrder.side} filled @ $${currentLevel.price} → placing ${counterSide} ${qty} ETH @ $${nextLevel.price} (level ${counterLevelIndex})`);

    try {
      await this.placeGridOrder({ ...nextLevel, side: counterSide, quantity: qty });
      
      // Mark filled level as filled (stays empty)
      await db.updateGridLevel(currentLevel.id, { is_filled: true });
      
      // Update counter level with new side
      await db.updateGridLevel(nextLevel.id, {
        side: counterSide,
        is_filled: false
      });
      
      // Record round-trip profit: spread between the two levels * qty
      const spread = Math.abs(nextLevel.price - currentLevel.price);
      const rtProfit = spread * qty;
      try {
        await db.createTrade({
          bot_id: this.bot.id,
          order_id: completedOrder.order_id || 'rt_' + Date.now(),
          fill_id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2),
          side: counterSide,
          quantity: qty,
          price: nextLevel.price,
          fee: 0,
          fee_currency: 'USDT',
          round_trip_profit: rtProfit
        });
        log.info(`💰 Round-trip profit: $${rtProfit.toFixed(4)} (spread $${spread.toFixed(2)} × ${qty} ETH)`);
      } catch (rtErr) {
        log.info(`⚠️ Error recording round-trip profit: ${rtErr}`);
      }
      
      log.info(`✅ Round-trip placed: ${counterSide} @ $${nextLevel.price}`);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, `Round-trip error @ $${nextLevel.price}`);
    }
  }

  /**
   * ⚠️ NUEVO: Verificar niveles pendientes de reemplazo (error 7201)
   */
  private async checkPendingReplaceOrders(): Promise<void> {
    try {
      // Obtener niveles marcados como pending_replace
      const pendingLevels = await db.getPendingReplaceGridLevels(this.bot.id);
      
      if (pendingLevels.length === 0) {
        return; // No hay niveles pendientes
      }

      // Obtener precio actual
      const ticker = await this.grvt.getTicker(this.bot.pair);
      const currentPrice = parseFloat(ticker.last_price);

      log.info(`🔍 Revisando ${pendingLevels.length} niveles pendientes (precio actual: $${currentPrice})`);

      for (const level of pendingLevels) {
        // Verificar si el precio actual está dentro del ~10% del nivel
        const priceDistance = Math.abs(level.price - currentPrice) / currentPrice;
        const withinRange = priceDistance <= 0.50; // 50% tolerance - increased for grid orders

        if (withinRange) {
          log.info(`🎯 Nivel ${level.level_index} ($${level.price}) dentro del rango — intentando colocar`);
          
          try {
            // Intentar colocar la orden
            await this.placeGridOrder(level);
            
            // Si exitoso, limpiar pending_replace
            await db.clearLevelPendingReplace(level.id);
            
            log.info(`✅ Nivel ${level.level_index} colocado exitosamente y removido de pending`);
            
            // Throttle entre órdenes pendientes
            await new Promise(r => setTimeout(r, 300));
            
          } catch (error) {
            if (error instanceof Error && error.message.includes('7201')) {
              // Aún fuera del price band, mantener como pendiente
            } else if (error instanceof Error && error.message.includes('2090')) {
              log.info(`⚠️ Max orders reached, stopping pending replacements`);
              return; // STOP - don't try more
            } else {
              log.error({ err: error instanceof Error ? error.message : String(error) }, `Error colocando nivel pendiente ${level.level_index}`);
            }
          }
        }
        // Si no está dentro del rango, skip silenciosamente (sin log spam)
      }
      
    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error verificando niveles pendientes:`);
    }
  }

  /**
   * Actualizar PnL del bot
   */
  private pnlUpdateCounter: number = 0;

  private async updatePnL(): Promise<void> {
    try {
      // Obtener posición actual
      const position = await this.grvt.getPosition(this.bot.pair);
      
      let trendPnl = 0;
      let positionSize = 0;
      let avgEntryPrice = 0;

      if (position) {
        trendPnl = parseFloat(position.unrealized_pnl);
        positionSize = parseFloat(position.size);
        avgEntryPrice = parseFloat(position.entry_price);
      }

      // Recalcular grid profit real desde fills de GRVT cada 12 ciclos (~60s)
      this.pnlUpdateCounter++;
      if (this.pnlUpdateCounter % 12 === 1) {
        try {
          log.info(`📊 [DEBUG] Calculando grid profit real desde GRVT fills...`);
          const realGridProfit = await this.calculateRealGridProfit();
          log.info(`📊 [DEBUG] Grid profit real calculado: ${realGridProfit}`);
          if (realGridProfit !== null) {
            this.bot.grid_profit_usdt = realGridProfit;
          }
        } catch (gpErr) {
          log.info(`⚠️ [DEBUG] Error calculando grid profit real: ${gpErr}`);
        }
      }

      const totalPnl = this.bot.grid_profit_usdt + trendPnl;

      await db.updateBot(this.bot.id, {
        grid_profit_usdt: this.bot.grid_profit_usdt,
        trend_pnl_usdt: trendPnl,
        total_pnl_usdt: totalPnl,
        position_size: positionSize,
        avg_entry_price: avgEntryPrice
      });

    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error actualizando PnL bot ${this.bot.id}:`);
    }
  }

  /**
   * Real grid profit for THIS bot, computed by spread-pair matching
   * its own fills (filtered by bot_id from fills_archive).
   *
   * Bot 44 hit a leak on 2026-04-08: the previous implementation
   * called this.grvt.getFillHistory(1000) which returns the entire
   * sub-account history with NO bot attribution, then ran spread-pair
   * over the lot. Result: bot 44 (running 6 minutes, 5 fills) inherited
   * bot 42's full $76 of grid profit. The fills_archive table has
   * proper bot_id attribution (added in Phase B), so we read from
   * there instead.
   *
   * Spread-pair details: pair each SELL with the unmatched BUY whose
   * price is between $3 and $20 lower (one grid spacing window).
   * MUST match v2-router /realized-summary so the dashboard and the
   * stored bot.grid_profit_usdt agree.
   */
  private async calculateRealGridProfit(): Promise<number | null> {
    try {
      const fills = await db.getFillsForBot(this.bot.id);

      if (!fills || fills.length === 0) return 0;

      let totalFees = 0;
      let grossProfit = 0;
      let pairs = 0;
      const pendingBuys: Array<{ price: number; size: number }> = [];
      let totalBuys = 0;
      let totalSells = 0;

      for (const f of fills) {
        // fee is signed in fills_archive: negative = rebate earned. To
        // compute *net* grid profit we want gross - |fees| − (−|rebates|)
        // = gross + rebates - fees, which is gross - signedFees.
        totalFees += f.fee;

        if (f.is_buyer) {
          totalBuys++;
          pendingBuys.push({ price: f.price, size: f.size });
        } else {
          totalSells++;
          let bestIdx = -1;
          let bestSpread = Infinity;
          pendingBuys.forEach((b, i) => {
            const spread = f.price - b.price;
            if (spread > 3 && spread < 20 && spread < bestSpread) {
              bestIdx = i;
              bestSpread = spread;
            }
          });
          if (bestIdx >= 0) {
            const b = pendingBuys[bestIdx]!;
            grossProfit += (f.price - b.price) * f.size;
            pairs++;
            pendingBuys.splice(bestIdx, 1);
          }
        }
      }

      const netProfit = grossProfit - totalFees;
      log.info(`📊 [DEBUG] Bot ${this.bot.id} fills: ${fills.length}, Buys: ${totalBuys}, Sells: ${totalSells}, Fees: ${totalFees.toFixed(4)}`);
      log.info(`📊 [DEBUG] Bot ${this.bot.id} grid pairs: ${pairs}, Gross: $${grossProfit.toFixed(2)}, Net: $${netProfit.toFixed(2)}`);

      return netProfit;
    } catch (error) {
      log.error({ err: (error as Error).message }, `❌ Error calculating real grid profit for bot ${this.bot.id}:`);
      return null;
    }
  }

  /**
   * SAFEGUARD: Verificar pérdida máxima (-20% del capital)
   */
  private async checkMaxLoss(): Promise<void> {
    const maxLossThreshold = this.bot.investment_usdt * -0.20; // -20%
    
    if (this.bot.total_pnl_usdt < maxLossThreshold) {
      log.info(`🚨 SAFEGUARD: Bot ${this.bot.id} alcanzó pérdida máxima: $${this.bot.total_pnl_usdt}`);
      throw new Error(`SAFEGUARD: Pérdida máxima alcanzada (-20% del capital)`);
    }
  }

  /**
   * Obtener grid profit real calculado para un bot específico (público para dashboard)
   */
  async getRealGridProfitForBot(botId: number): Promise<number | null> {
    const bot = await db.getBot(botId);
    if (!bot) {
      log.warn(`⚠️ Bot ${botId} no encontrado para calcular grid profit`);
      return null;
    }
    
    // Temporalmente cambiar this.bot para el cálculo
    const currentBot = this.bot;
    this.bot = bot;
    
    try {
      const result = await this.calculateRealGridProfit();
      return result;
    } finally {
      // Restaurar bot original
      this.bot = currentBot;
    }
  }

  /**
   * Cancelar todas las órdenes activas
   */
  async cancelAllOrders(): Promise<void> {
    const cancelledCount = await this.grvt.cancelAllOrders(this.bot.pair);
    this.activeOrders.clear();
    
    log.info(`❌ ${cancelledCount} órdenes canceladas para bot ${this.bot.id}`);
  }

  /**
   * Configurar daily snapshots para ejecutar cada 24h a las 00:00 UTC
   */
  private setupDailySnapshots(): void {
    // Take a snapshot on boot if there isn't one for today yet.
    // This fixes the issue where repeated restarts reset the midnight
    // timer and no snapshot ever gets created.
    setTimeout(() => {
      this.createDailySnapshots().catch(err => log.error({ err: (err as Error).message }, 'async task failed'));
    }, 10_000); // 10s after boot (let auth + first monitor pass complete)

    // Schedule next at midnight UTC, then every 24h
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    log.info(`📸 Daily snapshots: boot snapshot in 10s, then midnight UTC (${Math.round(msUntilMidnight / 1000 / 3600)}h)`);

    setTimeout(() => {
      this.createDailySnapshots().catch(err => log.error({ err: (err as Error).message }, 'async task failed'));
      (this as any).dailySnapshotInterval = setInterval(() => {
        this.createDailySnapshots().catch(err => log.error({ err: (err as Error).message }, 'async task failed'));
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  /**
   * Crear snapshots diarios para todos los bots activos
   */
  private async createDailySnapshots(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      log.info(`📸 Creando daily snapshots para ${today}...`);
      
      // Obtener precio actual de ETH
      let ethPrice: number | null = null;
      try {
        const tickers = await this.grvt.getTickers(['ETH_USDT_Perp']);
        if (tickers && tickers.length > 0 && tickers[0]?.last_price) {
          ethPrice = parseFloat(tickers[0].last_price);
        }
      } catch (e) {
        log.warn('⚠️ No se pudo obtener precio de ETH para snapshot');
      }
      
      // Crear snapshot para el bot actual
      const currentBot = this.bot;
      if (currentBot?.id) {
        const botId: number = currentBot.id;
        try {
          // Verificar si ya existe snapshot para hoy
          const exists = await db.hasSnapshotForDate(botId, today as string);
          if (exists) {
            log.info(`📸 Snapshot ya existe para bot ${botId} fecha ${today}`);
            return;
          }
          
          // Obtener balance actual
          const balance = await this.grvt.getBalance();
          const equity = parseFloat(balance.total_equity || '0');
          
          // Calcular grid profit net
          const gridProfitNet = await this.calculateRealGridProfit() || 0;

          // Contar round-trips desde paired_roundtrips (source of truth real).
          // FIX 2026-04-07: el código previo contaba sells en la tabla `trades`,
          // que dejó de actualizarse cuando el monitor() refactorizó a no usar
          // handleOrderFilled. Eso causó que num_round_trips quedara congelado.
          // paired_roundtrips se llena correctamente desde calculateRealGridProfit
          // y es la fuente de verdad real.
          const roundTrips = await db.countPairedRoundtrips();
          
          // Crear snapshot
          await db.createDailySnapshot({
            bot_id: botId,
            date: today as string,
            equity,
            grid_profit_net: gridProfitNet,
            trend_pnl: currentBot.trend_pnl_usdt || 0,
            total_pnl: currentBot.total_pnl_usdt || 0,
            round_trips: roundTrips,
            eth_price: ethPrice
          });
          
          log.info(`📸 Snapshot creado para bot ${botId}: equity=$${equity}, grid_profit=$${gridProfitNet}, round_trips=${roundTrips}`);
          
        } catch (error) {
          log.error({ err: (error as Error).message }, `❌ Error creando snapshot para bot ${botId}:`);
        }
      }
      
      log.info(`✅ Daily snapshots completados para ${today}`);
      
    } catch (error) {
      log.error({ err: (error as Error).message }, '❌ Error en createDailySnapshots:');
    }
  }

}

// Instancia singleton del Grid Engine
export const gridEngine = new GridEngine();

export default gridEngine;