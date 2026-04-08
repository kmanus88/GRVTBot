// Grid Trading Engine - Fase 3
// Lógica completa de grid trading con safeguards para dinero real

import { grvtClient } from '../api/client.js';
import { db } from '../database/db.js';
import type { GridBot, GridLevel, OrderRecord } from '../database/db.js';
import { EventEmitter } from 'events';

export interface GridConfig {
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

  constructor() {
    super();
    console.log('🤖 Grid Engine inicializado');
  }

  /**
   * Iniciar el engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Grid Engine ya está ejecutándose');
      return;
    }

    try {
      // Cargar bots activos de la database
      await this.loadActiveBots();
      
      // Iniciar monitoreo cada 5 segundos
      this.monitoringInterval = setInterval(() => {
        this.monitorAllBots().catch(console.error);
      }, 5000);

      // ⚠️ NUEVO: Polling funding history cada 30 minutos
      this.fundingPollingInterval = setInterval(() => {
        this.pollFundingHistory().catch(console.error);
      }, 30 * 60 * 1000); // 30 minutos

      // ⚠️ NUEVO: Compound check cada hora
      this.compoundCheckInterval = setInterval(() => {
        this.checkCompoundRebalance().catch(err => console.error('Compound check error:', err));
      }, 60 * 60 * 1000); // Check every hour

      // ⚠️ NUEVO: Daily snapshots cada 24h (00:00 UTC)
      // Inline setup (method is on GridBotInstance, not GridEngine)
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      const msUntilMidnight = tomorrow.getTime() - now.getTime();
      console.log(`📸 Daily snapshots configurados - próximo en ${Math.round(msUntilMidnight / 1000 / 3600)} horas`);
      // Note: actual snapshot logic is in GridBotInstance.createDailySnapshots()

      // ⚠️ NUEVO: Backfill inicial de funding history
      setTimeout(() => {
        this.backfillFundingHistory().catch(console.error);
      }, 5000); // Ejecutar después de 5s para que el engine esté listo

      // Phase B.10: Fill archive poller — pulls fill_history from GRVT
      // every 30s, dedupes by fill_id, writes to fills_archive +
      // paired_roundtrips. The user discovered that fills_archive had
      // been frozen since 2026-03-24 because nothing was writing to it
      // in the engine — the schema existed but the writer was never
      // implemented. This loop is the writer.
      this.fillPollingInterval = setInterval(() => {
        this.pollFillArchive().catch((err) => {
          console.error('❌ Fill archive poller error:', err.message);
        });
      }, 30 * 1000);
      // First poll fires 8s after boot (after auth + initial monitor pass)
      setTimeout(() => {
        this.pollFillArchive().catch(console.error);
      }, 8_000);

      this.isRunning = true;
      console.log('✅ Grid Engine iniciado - monitoreando cada 5s, funding cada 30min, fills cada 30s, snapshots cada 24h');
      
    } catch (error) {
      console.error('❌ Error iniciando Grid Engine:', error);
      throw error;
    }
  }

  /**
   * Parar el engine
   */
  async stop(): Promise<void> {
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

    // Pausar todos los bots
    for (const [botId, botInstance] of this.bots) {
      await this.pauseBot(botId);
    }

    console.log('🛑 Grid Engine detenido');
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
      
      // Crear bot en database (status = 'paused')
      const botId = await db.createBot({
        pair: config.pair,
        direction: config.direction,
        leverage: config.leverage,
        lower_price: config.lowerPrice,
        upper_price: config.upperPrice,
        num_grids: config.numGrids,
        investment_usdt: config.investmentUSDT,
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

      console.log(`✅ Bot creado: ID ${botId} - ${config.pair} ${config.direction} ${config.leverage}x (PAUSADO)`);
      this.emit('botCreated', { botId, config });

      return botId;

    } catch (error) {
      console.error('❌ Error creando bot:', error);
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
        console.log(`⚠️ Bot ${botId} ya está ejecutándose`);
        return;
      }

      // Detect existing GRVT-side state. Either signal triggers RESUME mode.
      const existingOrders = await grvtClient.getOpenOrders(bot.pair).catch((err) => {
        console.warn(`⚠️ getOpenOrders failed during startBot detection: ${err.message}`);
        return [];
      });
      const existingPosition = await grvtClient.getPosition(bot.pair).catch((err) => {
        console.warn(`⚠️ getPosition failed during startBot detection: ${err.message}`);
        return null;
      });
      const positionSize =
        existingPosition && (existingPosition as any).size
          ? Math.abs(parseFloat((existingPosition as any).size))
          : 0;
      const hasExistingState = existingOrders.length > 0 || positionSize > 0;

      const instance = new GridBotInstance(bot);
      this.bots.set(botId, instance);

      if (hasExistingState) {
        console.log(
          `🔁 Bot ${botId} RESUME — found ${existingOrders.length} open orders + position size ${positionSize}. Skipping bootstrap.`
        );
        await this.resumeBotInstance(bot, instance, existingOrders);
      } else {
        console.log(`🆕 Bot ${botId} FRESH START — no existing GRVT state, bootstrapping.`);
        // Verificar balance antes de iniciar
        await this.validateSufficientBalance(bot);
        // Establecer leverage
        await grvtClient.setLeverage(bot.pair, bot.leverage);
        // Colocar órdenes iniciales
        await instance.placeInitialOrders();
      }

      // Actualizar status a running (idem en ambos casos)
      await db.updateBot(botId, { status: 'running' });

      console.log(`🚀 Bot ${botId} iniciado - ${bot.pair} ${bot.direction} ${bot.leverage}x`);
      this.emit('botStarted', { botId });

    } catch (error) {
      // Roll back the in-memory instance registration so a failed start
      // doesn't leave a dangling instance the monitor loop will trip on.
      this.bots.delete(botId);
      console.error(`❌ Error iniciando bot ${botId}:`, error);
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

    console.log(
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
      
      console.log(`⏸️ Bot ${botId} pausado`);
      this.emit('botPaused', { botId });

    } catch (error) {
      console.error(`❌ Error pausando bot ${botId}:`, error);
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

      // Pausar primero
      await this.pauseBot(botId);

      // ⚠️ CRÍTICO: Consultar posición real de GRVT, NO usar DB
      console.log('📊 Consultando posición real en GRVT...');
      const positions = await grvtClient.getPositions();
      const position = positions.find(p => p.instrument === bot.pair);
      const realPositionSize = position ? parseFloat(position.size) : 0;

      console.log(`📍 Posición real: ${realPositionSize} (DB: ${bot.position_size})`);

      // Si hay posición abierta, cerrarla con orden agresiva
      if (realPositionSize !== 0) {
        const closeSide = realPositionSize > 0 ? 'sell' : 'buy';
        const closeSize = Math.abs(realPositionSize);

        console.log(`🔄 Cerrando posición: ${closeSide} ${closeSize} ${bot.pair}`);
        
        // Precio agresivo (0.5% peor que market) con GTC para garantizar fill
        const ticker = await grvtClient.getTicker(bot.pair);
        const currentPrice = parseFloat(ticker.last_price);
        const aggressivePrice = closeSide === 'sell' 
          ? Math.floor(currentPrice * 0.995 * 100) / 100   // 0.5% abajo para sell
          : Math.floor(currentPrice * 1.005 * 100) / 100;  // 0.5% arriba para buy
        
        // ⚠️ CRÍTICO: time_in_force debe matchear la firma EIP-712 (GTC = 1)
        await grvtClient.createOrder({
          sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID!,
          instrument: bot.pair,
          size: (Math.floor(closeSize * 100) / 100).toString(),
          price: aggressivePrice.toString(),
          side: closeSide,
          type: 'limit',
          time_in_force: 'gtc'  // GTC matchea timeInForce=1 en EIP-712
        }, true);

        console.log(`✅ Orden de cierre: ${closeSide} ${closeSize} @ $${aggressivePrice} (GTC)`);
      }

      // Actualizar status a stopped
      await db.updateBot(botId, { status: 'stopped', position_size: realPositionSize });

      console.log(`🛑 Bot ${botId} cerrado completamente`);
      this.emit('botClosed', { botId });

    } catch (error) {
      console.error(`❌ Error cerrando bot ${botId}:`, error);
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
        console.log(`🔧 [DEBUG] Cargando bot ${bot.id} - ${bot.pair} (status: ${bot.status})`);

        const instance = new GridBotInstance(bot);
        this.bots.set(bot.id, instance);

        const openOrders = await grvtClient.getOpenOrders(bot.pair);
        console.log(`📥 Bot ${bot.id}: ${openOrders.length} órdenes abiertas en GRVT`);

        // Shared resume logic with startBot()'s RESUME path.
        await this.resumeBotInstance(bot, instance, openOrders);

      } catch (error) {
        console.error(`❌ Error cargando bot ${bot.id}:`, error);
        this.bots.delete(bot.id);
        await db.updateBot(bot.id, { status: 'paused' });
      }
    }

    console.log(`✅ ${activeBots.length} bots activos cargados y verificados`);
  }

  /**
   * Monitorear todos los bots activos
   */
  private async monitorAllBots(): Promise<void> {
    if (!this.isRunning) return;

    for (const [botId, instance] of this.bots) {
      try {
        await instance.monitor();
      } catch (error) {
        console.error(`❌ Error monitoreando bot ${botId}:`, error);
        
        // Si hay errores críticos, pausar el bot
        if (error instanceof Error && error.message.includes('SAFEGUARD')) {
          console.log(`🚨 SAFEGUARD activado para bot ${botId} - pausando`);
          await this.pauseBot(botId);
          this.emit('safeguardTriggered', { botId, error: error.message });
        }
      }
    }
  }

  /**
   * Calcular niveles de grid
   * ⚠️ ACTUALIZADO: debe generar exactamente numGrids+1 niveles (ej: 130 grids = 131 niveles)
   */
  async calculateGridLevels(config: GridConfig): Promise<GridCalculation> {
    // Obtener precio actual
    const ticker = await grvtClient.getTicker(config.pair);
    const currentPrice = parseFloat(ticker.last_price);

    // Validar que el precio actual esté dentro del rango
    if (currentPrice <= config.lowerPrice || currentPrice >= config.upperPrice) {
      throw new Error(`Precio actual ${currentPrice} está fuera del rango [${config.lowerPrice}, ${config.upperPrice}]`);
    }

    // ⚠️ FIX: Calcular spacing correcto para generar numGrids grids (numGrids+1 niveles)
    const spacing = (config.upperPrice - config.lowerPrice) / config.numGrids;
    
    // ⚠️ FIX: Calcular quantity POR NIVEL en USD (no ETH fijo)
    // Cada grid tiene el mismo valor en USD → a precios más bajos, más ETH
    const usdPerGrid = (config.investmentUSDT * config.leverage) / config.numGrids;
    const minNotional = config.pair === 'ETH_USDT_Perp' ? 20 : 100;
    const minSize = config.pair === 'ETH_USDT_Perp' ? 0.01 : 0.001;

    console.log(`🧮 Grid calculation: ${config.numGrids} grids = ${config.numGrids + 1} niveles`);
    console.log(`🧮 Rango: $${config.lowerPrice} - $${config.upperPrice}`);
    console.log(`🧮 Spacing: $${spacing.toFixed(2)} por nivel`);
    console.log(`🧮 USD por grid: $${usdPerGrid.toFixed(2)} (con ${config.leverage}x leverage)`);

    // Generar niveles 0 a numGrids (inclusive) = numGrids+1 niveles total
    const gridLevels = [];
    for (let i = 0; i <= config.numGrids; i++) {
      const price = Math.round((config.lowerPrice + (i * spacing)) * 100) / 100;
      
      let side: 'buy' | 'sell';
      if (config.direction === 'long') {
        side = price < currentPrice ? 'buy' : 'sell';
      } else {
        side = price > currentPrice ? 'sell' : 'buy';
      }

      // Quantity en ETH = USD por grid / precio del nivel, redondeado a min_size
      let quantity = Math.ceil(usdPerGrid / price / minSize) * minSize;
      // Asegurar min_notional
      while (quantity * price < minNotional) {
        quantity += minSize;
      }
      quantity = Math.round(quantity * 100) / 100; // Round to 0.01

      gridLevels.push({
        index: i,
        price,
        side,
        quantity
      });
    }

    const quantityPerGrid = usdPerGrid / currentPrice; // Para el summary

    console.log(`🧮 Generados ${gridLevels.length} niveles (0 a ${config.numGrids})`);

    // Calcular profit estimado por grid
    const estimatedProfitPerGrid = spacing * quantityPerGrid;

    // Calcular liquidation price aproximado (non-fatal si falla)
    let liquidationPrice = 0;
    try {
      liquidationPrice = parseFloat(await grvtClient.calculateLiquidationPrice(config.pair, config.leverage));
    } catch (e) {
      console.log(`⚠️ No se pudo calcular liquidation price: ${(e as Error).message}`);
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

    console.log(`✅ [DEBUG] Configuración validada: ${config.numGrids} grids x $${investmentPerGrid.toFixed(2)} cada uno >= $${minNotional} min_notional`);
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
    const balance = await grvtClient.getBalance();
    const availableBalance = parseFloat(balance.available_balance);
    
    const requiredMargin = bot.investment_usdt / bot.leverage;
    
    console.log(`💰 [DEBUG] Validando balance: disponible $${availableBalance}, requerido $${requiredMargin}`);
    
    if (availableBalance < requiredMargin) {
      throw new Error(`Balance insuficiente: requerido $${requiredMargin.toFixed(2)}, disponible $${availableBalance.toFixed(2)}`);
    }
    
    // Validar que no exceda el 95% del balance total (safeguard)
    const totalBalance = parseFloat(balance.total_equity || balance.available_balance || '0');
    const maxInvestment = totalBalance * 0.95;
    if (bot.investment_usdt > maxInvestment) {
      throw new Error(`Inversión muy alta: máximo recomendado $${maxInvestment.toFixed(2)} (95% del balance total)`);
    }
    
    console.log(`✅ [DEBUG] Balance validado: margen OK, inversión dentro de límites seguros`);
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
      console.log(`💰 [DEBUG] Polling funding history...`);
      
      const activeBots = await db.getBotsByStatus('running');
      if (activeBots.length === 0) {
        console.log(`💰 [DEBUG] No hay bots activos, skipping funding poll`);
        return;
      }

      // Obtener funding history para cada instrumento único
      const instruments = [...new Set(activeBots.map(bot => bot.pair))];
      
      for (const instrument of instruments) {
        try {
          console.log(`💰 [DEBUG] Polling funding para ${instrument}...`);
          
          const fundingPayments = await grvtClient.getFundingHistory(50, instrument);
          console.log(`💰 [DEBUG] Recibidos ${fundingPayments.length} funding payments para ${instrument}`);
          
          // Obtener último funding time registrado para evitar duplicados
          const existingFunding = await db.getFundingHistoryByBot(activeBots[0]!.id);
          const lastFundingTime = existingFunding.length > 0 ? 
            new Date(existingFunding[0]!.funding_time).getTime() : 0;

          // Filtrar nuevos payments
          const newPayments = fundingPayments.filter(payment => 
            payment.funding_time * 1000 > lastFundingTime
          );

          console.log(`💰 [DEBUG] ${newPayments.length} nuevos funding payments para ${instrument}`);

          // Registrar nuevos payments para cada bot del instrumento
          const botsForInstrument = activeBots.filter(bot => bot.pair === instrument);
          
          for (const payment of newPayments) {
            for (const bot of botsForInstrument) {
              try {
                // Convertir payment de raw a USDT (÷ 1e6)
                const paymentUsdt = parseFloat(payment.payment) / 1e6;
                
                await db.createFundingRecord({
                  bot_id: bot.id,
                  instrument: instrument,
                  funding_rate: parseFloat(payment.funding_rate),
                  payment_usdt: paymentUsdt,
                  position_size: parseFloat(payment.position_size),
                  funding_time: new Date(payment.funding_time * 1000).toISOString()
                });
                
                console.log(`💰 [DEBUG] Funding registrado para bot ${bot.id}: ${paymentUsdt.toFixed(4)} USDT`);
                
              } catch (fundingErr) {
                console.error(`❌ Error registrando funding para bot ${bot.id}:`, fundingErr);
              }
            }
          }

          // Throttle entre instrumentos
          await new Promise(r => setTimeout(r, 1000));

        } catch (instrumentErr) {
          console.error(`❌ Error polling funding para ${instrument}:`, instrumentErr);
        }
      }

      console.log(`✅ Funding history polling completado`);

    } catch (error) {
      console.error(`❌ Error en polling funding history:`, error);
    }
  }

  /**
   * ⚠️ NUEVO: Backfill inicial de funding history al startup
   */
  private async backfillFundingHistory(): Promise<void> {
    try {
      console.log(`🔄 [DEBUG] Iniciando backfill de funding history...`);
      
      const allBots = await db.getAllBots();
      if (allBots.length === 0) {
        console.log(`🔄 [DEBUG] No hay bots, skipping backfill`);
        return;
      }

      // Obtener instrumentos únicos
      const instruments = [...new Set(allBots.map(bot => bot.pair))];
      
      for (const instrument of instruments) {
        try {
          console.log(`🔄 [DEBUG] Backfill funding para ${instrument}...`);
          
          // Obtener todo el funding history disponible (últimos 500)
          const allFunding = await grvtClient.getFundingHistory(500, instrument);
          console.log(`🔄 [DEBUG] Total funding history disponible: ${allFunding.length}`);
          
          // Obtener bots para este instrumento
          const botsForInstrument = allBots.filter(bot => bot.pair === instrument);
          
          // Para cada bot, registrar funding history desde su fecha de creación
          for (const bot of botsForInstrument) {
            const botCreatedTime = new Date(bot.created_at).getTime();
            
            // Filtrar funding después de la creación del bot
            const relevantFunding = allFunding.filter(payment => 
              payment.funding_time * 1000 >= botCreatedTime
            );

            console.log(`🔄 [DEBUG] Bot ${bot.id}: ${relevantFunding.length} funding payments relevantes`);

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
                  instrument: instrument,
                  funding_rate: parseFloat(payment.funding_rate),
                  payment_usdt: paymentUsdt,
                  position_size: parseFloat(payment.position_size),
                  funding_time: fundingTimeStr
                });

              } catch (recordErr) {
                console.error(`❌ Error registrando funding record:`, recordErr);
              }
            }

            console.log(`🔄 [DEBUG] Backfill completado para bot ${bot.id}`);
          }

          // Throttle entre instrumentos
          await new Promise(r => setTimeout(r, 2000));

        } catch (instrumentErr) {
          console.error(`❌ Error backfill funding para ${instrument}:`, instrumentErr);
        }
      }

      console.log(`✅ Funding history backfill completado`);

    } catch (error) {
      console.error(`❌ Error en backfill funding history:`, error);
    }
  }

  private async checkCompoundRebalance(): Promise<void> {
    try {
      const bots = await db.getAllBots();

      for (const bot of bots) {
        if (bot.status !== 'running') continue;

        // Read compound settings from DB columns (NOT params_json)
        const pct = (bot as any).compound_pct || 0;
        const threshold = (bot as any).compound_threshold_usdt || 100;
        const intervalHours = (bot as any).compound_interval_hours || 168;
        const lastCompoundAt = (bot as any).last_compound_at;

        if (pct <= 0) continue; // Compound disabled

        // Check if enough time has passed since last compound
        if (lastCompoundAt) {
          const hoursSince = (Date.now() - new Date(lastCompoundAt).getTime()) / (1000 * 60 * 60);
          if (hoursSince < intervalHours) continue;
        }

        // ── GET REAL GRID PROFIT (NOT BALANCE DIFF) ─────────────────
        // The previous implementation did `balance - investment_usdt`
        // which catastrophically conflates real grid profit with any
        // external margin transferred into the sub-account: every
        // dollar the user moved in via funding→trading was treated as
        // bot profit and reinvested. We now use the bot's own
        // `grid_profit_usdt` (live, computed from spread-paired fills
        // — see calculateRealGridProfit) which is independent of
        // balance changes and only counts actual round-trip earnings.
        //
        // We then SUBTRACT the cumulative compound amount already
        // taken so the same profit isn't compounded twice.
        const gridProfitTotal = bot.grid_profit_usdt ?? 0;

        const compoundedSoFarRow = await db.getCompoundedTotal(bot.id);
        const alreadyCompounded = compoundedSoFarRow ?? 0;

        const availableProfit = gridProfitTotal - alreadyCompounded;

        if (availableProfit < threshold) {
          console.log(`📊 Compound check bot ${bot.id}: available profit $${availableProfit.toFixed(2)} < threshold $${threshold} — skipping`);
          continue;
        }

        // Calculate compound amount from REAL grid profit only.
        const compoundAmount = availableProfit * (pct / 100);
        const newInvestment = bot.investment_usdt + compoundAmount;

        console.log(`🔄 Compounding bot ${bot.id}: +$${compoundAmount.toFixed(2)} (${pct}% of $${availableProfit.toFixed(2)} available grid profit; lifetime: $${gridProfitTotal.toFixed(2)}, prev compounded: $${alreadyCompounded.toFixed(2)})`);

        // SAFE: Only update investment_usdt and last_compound_at in DB
        // NO pauseBot, NO startBot, NO recalculating grid levels
        // Monitor reads investment_usdt each cycle and uses dynamic qty for new orders
        await db.updateBot(bot.id, {
          investment_usdt: newInvestment,
          last_compound_at: new Date().toISOString()
        } as any);

        // Log the movement so /realized-summary and the dashboard can
        // always reconstruct the cash flow trail.
        await db.recordCashMovement({
          bot_id: bot.id,
          type: 'compound',
          amount_usdt: compoundAmount,
          notes: `${pct}% of $${availableProfit.toFixed(2)} grid profit (lifetime $${gridProfitTotal.toFixed(2)})`,
        });

        console.log(`✅ Bot ${bot.id} compuesto: $${bot.investment_usdt.toFixed(2)} → $${newInvestment.toFixed(2)}`);
      }

    } catch (error) {
      console.error(`❌ Error en compound rebalance:`, error);
    }
  }

  async updateBotRange(botId: number, newLower: number, newUpper: number): Promise<void> {
    try {
      const bot = await db.getBot(botId);
      if (!bot) {
        throw new Error(`Bot ${botId} not found`);
      }

      // Get current price to validate range
      const ticker = await grvtClient.getTicker(bot.pair);
      const currentPrice = parseFloat(ticker.last_price);
      
      // Validate that current price is within new range
      if (currentPrice < newLower || currentPrice > newUpper) {
        throw new Error(`Current price $${currentPrice} is outside new range $${newLower}-$${newUpper}`);
      }

      console.log(`🔄 Updating range for bot ${botId}: $${bot.lower_price}-$${bot.upper_price} → $${newLower}-$${newUpper}`);

      // ===== ETH AUTO-PURCHASE LOGIC =====
      // Calculate how many SELL levels will be needed in the new range
      const ethTargetGrids = bot.num_grids;
      const ethNewSpacing = (newUpper - newLower) / ethTargetGrids;
      
      let sellLevelsCount = 0;
      for (let i = 0; i <= ethTargetGrids; i++) {
        const price = newLower + (i * ethNewSpacing);
        if (price > currentPrice) {
          sellLevelsCount++;
        }
      }

      // Calculate ETH needed for sell levels (using dynamic formula)
      const effectiveCapital = bot.investment_usdt * bot.leverage;
      const estimatedPrice = bot.pair.includes('ETH') ? currentPrice : 42000; // Use current price for ETH
      const orderQty = effectiveCapital / (bot.num_grids * estimatedPrice);
      const ethNeeded = sellLevelsCount * orderQty;

      console.log(`📊 ETH check: need ${ethNeeded.toFixed(4)} ETH for ${sellLevelsCount} sell levels`);

      // Get current position
      let currentPosition = 0;
      try {
        const position = await grvtClient.getPosition(bot.pair);
        if (position) {
          currentPosition = parseFloat(position.size);
        }
      } catch (posErr) {
        console.log(`⚠️ Could not get position for ${bot.pair}, assuming 0: ${posErr instanceof Error ? posErr.message : posErr}`);
      }

      console.log(`📍 Current ETH position: ${currentPosition.toFixed(4)} ETH, need: ${ethNeeded.toFixed(4)} ETH`);

      // Check if we need to buy more ETH
      if (currentPosition < ethNeeded) {
        const deficit = ethNeeded - currentPosition;
        console.log(`💰 ETH deficit detected: ${deficit.toFixed(4)} ETH. Buying at market...`);

        try {
          // Get current ticker for aggressive pricing
          const currentTicker = await grvtClient.getTicker(bot.pair);
          const markPrice = parseFloat(currentTicker.last_price);
          const buyPrice = Math.ceil(markPrice * 1.005 * 100) / 100; // +0.5% to ensure fill

          const marketOrder = await grvtClient.createOrder({
            sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID!,
            instrument: bot.pair,
            size: (Math.ceil(deficit * 10000) / 10000).toString(), // Round up to 4 decimals
            price: buyPrice.toString(),
            side: 'buy',
            type: 'limit',
            time_in_force: 'ioc', // Immediate or Cancel (market taker)
            metadata: `eth_auto_purchase_range_update_${botId}`
          }, true); // allowMarket=true

          console.log(`💰 ETH purchase order sent: ${marketOrder.order_id} for ${deficit.toFixed(4)} ETH at $${buyPrice}`);

          // Wait for order execution (small delay)
          await new Promise(r => setTimeout(r, 2000));

          // Verify the purchase was successful
          let newPosition = currentPosition;
          try {
            const updatedPosition = await grvtClient.getPosition(bot.pair);
            if (updatedPosition) {
              newPosition = parseFloat(updatedPosition.size);
            }
          } catch (verifyErr) {
            console.log(`⚠️ Could not verify position after purchase: ${verifyErr instanceof Error ? verifyErr.message : verifyErr}`);
          }

          if (newPosition < ethNeeded) {
            throw new Error(`ETH purchase failed or incomplete. Position: ${newPosition.toFixed(4)} ETH, needed: ${ethNeeded.toFixed(4)} ETH`);
          }

          console.log(`✅ ETH purchase successful! New position: ${newPosition.toFixed(4)} ETH`);

        } catch (purchaseError) {
          console.error(`❌ Failed to purchase ETH:`, purchaseError);
          throw new Error(`Cannot update range: ETH auto-purchase failed - ${purchaseError instanceof Error ? purchaseError.message : purchaseError}`);
        }
      } else {
        console.log(`✅ Sufficient ETH available (${currentPosition.toFixed(4)} >= ${ethNeeded.toFixed(4)})`);
      }
      // ===== END ETH AUTO-PURCHASE LOGIC =====

      // Cancel and remove orders outside new range
      const gridLevels = await db.getGridLevels(botId);
      const levelsToRemove = gridLevels.filter(level => 
        level.price < newLower || level.price > newUpper
      );

      const instance = this.bots.get(botId);
      if (instance) {
        for (const level of levelsToRemove) {
          // Cancel order if it exists
          if (level.order_id && level.order_id !== '0x00' && level.order_id !== 'price_based_detection') {
            try {
              await grvtClient.cancelOrder(level.order_id, bot.pair);
              console.log(`🗑️ Cancelled order ${level.order_id} @ $${level.price}`);
            } catch (cancelErr) {
              console.log(`⚠️ Could not cancel order ${level.order_id}: ${cancelErr instanceof Error ? cancelErr.message : cancelErr}`);
            }
          }
        }
      }

      // Delete levels outside range from DB
      const deletedCount = await db.deleteGridLevelsOutsideRange(botId, newLower, newUpper);
      console.log(`🗑️ Deleted ${deletedCount} grid levels outside new range`);

      // Calculate and create new levels for expanded range
      const remainingLevels = gridLevels.filter(level => 
        level.price >= newLower && level.price <= newUpper
      );
      
      // Calculate new grid spacing based on desired number of grids
      const targetGrids = bot.num_grids;
      const newSpacing = (newUpper - newLower) / targetGrids;
      
      // Generate all new grid levels
      const newGridLevels: any[] = [];
      for (let i = 0; i <= targetGrids; i++) {
        const price = newLower + (i * newSpacing);
        
        // Skip if level already exists (within $0.50)
        const exists = remainingLevels.some(existing => 
          Math.abs(existing.price - price) < 0.5
        );
        if (exists) continue;
        
        // Determine side based on current price
        const side = price < currentPrice ? 'buy' : 'sell';
        
        // Calculate quantity per grid based on investment and leverage
        const effectiveCapital = bot.investment_usdt * bot.leverage;
        const estimatedPrice = bot.pair.includes('ETH') ? 2100 : 42000; // Fallback
        const quantityPerGrid = effectiveCapital / (bot.num_grids * estimatedPrice);
        
        newGridLevels.push({
          bot_id: botId,
          level_index: i,
          side,
          price: Math.round(price * 100) / 100,
          quantity: quantityPerGrid,
          is_filled: false,
          order_id: '0x00'
        });
      }

      // Insert new levels into database
      for (const levelData of newGridLevels) {
        await db.createGridLevel(levelData);
      }

      // Place orders for new levels
      if (instance) {
        const newLevels = await db.getGridLevels(botId);
        const levelsToPlace = newLevels.filter(level => 
          level.order_id === '0x00' && !level.is_filled
        );

        for (const level of levelsToPlace) {
          try {
            await instance.placeGridOrder(level);
            console.log(`✅ Placed new order: ${level.side} @ $${level.price}`);
            await new Promise(r => setTimeout(r, 500)); // Throttle
          } catch (placeErr) {
            console.error(`❌ Failed to place order @ $${level.price}: ${placeErr instanceof Error ? placeErr.message : placeErr}`);
          }
        }
      }

      // Update bot range in database
      await db.updateBot(botId, {
        lower_price: newLower,
        upper_price: newUpper
      });

      console.log(`✅ Range update completed for bot ${botId}`);

    } catch (error) {
      console.error(`❌ Error updating bot range:`, error);
      throw error;
    }
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

    let allFills: any[];
    try {
      allFills = await grvtClient.getFillHistory(1000);
    } catch (err) {
      console.warn(`⚠️ Fill poller: getFillHistory failed: ${(err as Error).message}`);
      return;
    }
    if (!Array.isArray(allFills) || allFills.length === 0) return;

    let newFillCount = 0;
    let newFeeSum = 0;
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
      });
      if (inserted) {
        newFillCount++;
        newFeeSum += fee;
      }
    }

    if (newFillCount > 0) {
      console.log(
        `📥 Fill archive: +${newFillCount} new fills (real fee sum ${newFeeSum.toFixed(6)} USDT, ${newFeeSum < 0 ? 'rebate earned' : 'fees paid'})`
      );
    }
  }
}

/**
 * Instancia individual de un Grid Bot
 */
class GridBotInstance {
  private bot: GridBot;
  private gridLevels: GridLevel[] = [];
  private activeOrders = new Map<string, OrderRecord>();
  private processedFills = new Set<string>(); // ⚠️ NUEVO: Deduplicación de fills

  constructor(bot: GridBot) {
    this.bot = bot;
  }

  async loadGridLevels(): Promise<void> {
    this.gridLevels = await db.getGridLevels(this.bot.id);
    console.log(`📊 Bot ${this.bot.id}: ${this.gridLevels.length} grid levels cargados`);
  }

  getGridLevels(): GridLevel[] {
    return this.gridLevels;
  }

  /**
   * Calculate FIXED qty per grid level using midpoint price.
   * Same qty for ALL levels — ensures clean round-trips (buy qty = sell qty).
   */
  getFixedQty(): number {
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
    console.log(`🚀 [DEBUG] Bot ${this.bot.id}: INICIANDO placeInitialOrders()`);
    
    // Cargar niveles de grid
    this.gridLevels = await db.getGridLevels(this.bot.id);
    console.log(`🔍 [DEBUG] Bot ${this.bot.id}: Cargados ${this.gridLevels.length} niveles de grid`);
    
    // Obtener precio actual
    const ticker = await grvtClient.getTicker(this.bot.pair);
    const currentPrice = parseFloat(ticker.last_price);

    console.log(`📊 Bot ${this.bot.id}: Precio actual ${this.bot.pair}: $${currentPrice}`);
    console.log(`📊 Bot ${this.bot.id}: Estrategia ${this.bot.direction.toUpperCase()} con ${this.gridLevels.length} niveles`);
    console.log(`📊 Bot ${this.bot.id}: Rango: $${this.gridLevels[0]?.price} - $${this.gridLevels[this.gridLevels.length - 1]?.price}`);
    
    // ⚠️ PASO 1: COMPRA INICIAL para bots LONG
    if (this.bot.direction === 'long') {
      await this.executeInitialPurchase(currentPrice);
    }

    // ⚠️ DRY RUN warning
    if (process.env.DRY_RUN === 'true') {
      console.log(`🧪 [DRY RUN] Bot ${this.bot.id}: Modo testing activado - NO se colocarán órdenes reales`);
    }

    let ordersToPlace = 0;
    let ordersPlaced = 0;
    let ordersSkipped = 0;

    // ⚠️ PASO 2: Colocar órdenes limit según la dirección
    for (const level of this.gridLevels) {
      console.log(`🔍 [DEBUG] Bot ${this.bot.id}: Evaluando nivel ${level.level_index}: ${level.side} ${level.quantity} @ $${level.price} (filled: ${level.is_filled})`);
      
      if (level.is_filled) {
        ordersSkipped++;
        console.log(`⏭️ [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} ya está filled, saltando`);
        continue;
      }

      const shouldPlace = this.shouldPlaceOrder(level, currentPrice);
      console.log(`🤔 [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} shouldPlace: ${shouldPlace} (current: $${currentPrice}, level: $${level.price}, side: ${level.side})`);
      
      if (shouldPlace) {
        ordersToPlace++;
        console.log(`📝 [DEBUG] Bot ${this.bot.id}: Colocando orden nivel ${level.level_index}...`);
        try {
          await this.placeGridOrder(level);
          ordersPlaced++;
          console.log(`✅ [DEBUG] Bot ${this.bot.id}: Orden nivel ${level.level_index} colocada exitosamente`);
          // Throttle: 200ms entre órdenes para evitar rate limit GRVT
          await new Promise(r => setTimeout(r, 200));
        } catch (error) {
          console.error(`❌ [DEBUG] Error colocando orden nivel ${level.level_index}:`, error);
        }
      } else {
        console.log(`❌ [DEBUG] Bot ${this.bot.id}: Nivel ${level.level_index} NO cumple condiciones para colocar`);
      }
    }

    console.log(`✅ [DEBUG] Bot ${this.bot.id}: RESUMEN - ${ordersPlaced}/${ordersToPlace} órdenes ${process.env.DRY_RUN === 'true' ? '(simuladas)' : 'colocadas'}, ${ordersSkipped} saltadas`);
    console.log(`🎯 [DEBUG] Bot ${this.bot.id}: TERMINADO placeInitialOrders()`);
  }

  /**
   * NUEVO: Ejecutar compra inicial para grid LONG
   */
  private async executeInitialPurchase(currentPrice: number): Promise<void> {
    console.log(`💰 [DEBUG] Bot ${this.bot.id}: INICIANDO compra inicial para estrategia LONG`);

    // Calcular niveles SELL arriba del precio actual
    const sellLevelsAbove = this.gridLevels.filter(level => 
      level.price > currentPrice && !level.is_filled
    ).sort((a, b) => a.price - b.price);

    if (sellLevelsAbove.length === 0) {
      console.log(`⚠️ [DEBUG] Bot ${this.bot.id}: No hay niveles SELL arriba del precio actual, saltando compra inicial`);
      return;
    }

    // Calcular cantidad total de ETH necesaria
    const totalQuantityNeeded = sellLevelsAbove.reduce((sum, level) => sum + level.quantity, 0);
    const notionalUSDT = totalQuantityNeeded * currentPrice;

    console.log(`💰 [DEBUG] Bot ${this.bot.id}: Niveles SELL arriba: ${sellLevelsAbove.length}`);
    console.log(`💰 [DEBUG] Bot ${this.bot.id}: Cantidad total necesaria: ${totalQuantityNeeded} ETH`);
    console.log(`💰 [DEBUG] Bot ${this.bot.id}: Notional USDT: $${notionalUSDT.toFixed(2)}`);

    // Validar min_notional
    const minNotional = this.bot.pair === 'ETH_USDT_Perp' ? 20 : 100;
    if (notionalUSDT < minNotional) {
      console.log(`⚠️ [DEBUG] Bot ${this.bot.id}: Notional $${notionalUSDT.toFixed(2)} < min_notional $${minNotional}, saltando compra inicial`);
      return;
    }

    try {
      if (process.env.DRY_RUN === 'true') {
        console.log(`🧪 [DRY RUN] Bot ${this.bot.id}: COMPRA INICIAL que se ejecutaría: BUY ${totalQuantityNeeded} ${this.bot.pair} @ MARKET [notional: $${notionalUSDT.toFixed(2)}]`);
        
        // En dry run, simular la compra
        await db.updateBot(this.bot.id, {
          position_size: totalQuantityNeeded,
          avg_entry_price: currentPrice
        });
        
        console.log(`✅ [DRY RUN] Bot ${this.bot.id}: Compra inicial simulada exitosamente`);
        return;
      }

      // 💰 MODO REAL: Ejecutar compra market usando IOC
      console.log(`💰 [REAL] Bot ${this.bot.id}: Ejecutando compra inicial MARKET...`);

      // Usar precio ligeramente arriba del ask para asegurar fill
      const ticker = await grvtClient.getTicker(this.bot.pair);
      const askPrice = parseFloat((ticker as any).best_ask_price || (ticker as any).best_ask || ticker.last_price);
      const safeBuyPrice = Math.floor(askPrice * 1.001 * 100) / 100; // 0.1% arriba del ask, rounded to tick

      const order = await grvtClient.createOrder({
        sub_account_id: process.env.GRVT_TRADING_ACCOUNT_ID!,
        instrument: this.bot.pair,
        size: (Math.floor(totalQuantityNeeded * 100) / 100).toString(), // Round to 0.01
        price: safeBuyPrice.toString(),
        side: 'buy',
        type: 'limit', // IOC es tipo limit con time_in_force especial
        time_in_force: 'ioc', // IMMEDIATE_OR_CANCEL
        metadata: `initial_purchase_${this.bot.id}`
      }, true); // allowMarket=true

      console.log(`💰 [REAL] Bot ${this.bot.id}: Compra inicial enviada: ${order.order_id}`);

      // Esperar un momento para que se ejecute
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verificar si se ejecutó
      const fills = await grvtClient.getFillHistory(10, this.bot.pair!);
      const initialFills = fills.filter(fill => 
        fill.order_id === order.order_id && fill.side === 'buy'
      );

      if (initialFills.length > 0) {
        const totalFilled = initialFills.reduce((sum, fill) => sum + parseFloat(fill.size), 0);
        const avgPrice = initialFills.reduce((sum, fill) => sum + parseFloat(fill.price) * parseFloat(fill.size), 0) / totalFilled;

        console.log(`✅ [REAL] Bot ${this.bot.id}: Compra inicial ejecutada: ${totalFilled} ETH @ $${avgPrice.toFixed(2)}`);

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
        console.log(`⚠️ [REAL] Bot ${this.bot.id}: Compra inicial no se ejecutó completamente, continuando con órdenes limit`);
      }

      // IMPORTANTE: Colocar SELL en el nivel justo arriba del precio de entry
      // Esto cierra el "gap" que queda entre los BUYs de abajo y los SELLs de arriba
      const entryLevel = this.gridLevels
        .filter(l => l.price > currentPrice)
        .sort((a, b) => a.price - b.price)[0];
      
      if (entryLevel) {
        console.log(`📍 [DEBUG] Bot ${this.bot.id}: Colocando SELL en nivel de entry $${entryLevel.price} (cierra gap)`);
        try {
          const entryOrder = { ...entryLevel, side: 'sell' as const };
          await this.placeGridOrder(entryOrder);
          console.log(`✅ Bot ${this.bot.id}: SELL de entry colocada en $${entryLevel.price}`);
        } catch (err) {
          console.log(`⚠️ Bot ${this.bot.id}: No se pudo colocar SELL de entry: ${err}`);
        }
      }

    } catch (error) {
      console.error(`❌ [DEBUG] Error en compra inicial para bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Determinar si debe colocarse una orden en este nivel
   */
  private shouldPlaceOrder(level: GridLevel, currentPrice: number): boolean {
    console.log(`🧐 [DEBUG] shouldPlaceOrder() - Bot: ${this.bot.id}, Level: ${level.level_index}, Direction: ${this.bot.direction}`);
    console.log(`🧐 [DEBUG] shouldPlaceOrder() - Level: ${level.side} @ $${level.price}, Current: $${currentPrice}`);
    
    let result = false;
    
    if (this.bot.direction === 'long') {
      // LONG: buy orders debajo del precio, sell orders arriba
      const buyCondition = level.side === 'buy' && level.price < currentPrice;
      const sellCondition = level.side === 'sell' && level.price > currentPrice;
      result = buyCondition || sellCondition;
      
      console.log(`🧐 [DEBUG] shouldPlaceOrder() LONG - buyCondition: ${buyCondition} (${level.side}==='buy' && ${level.price}<${currentPrice})`);
      console.log(`🧐 [DEBUG] shouldPlaceOrder() LONG - sellCondition: ${sellCondition} (${level.side}==='sell' && ${level.price}>${currentPrice})`);
      console.log(`🧐 [DEBUG] shouldPlaceOrder() LONG - result: ${result}`);
      
    } else {
      // SHORT: sell orders arriba del precio, buy orders debajo  
      const sellCondition = level.side === 'sell' && level.price > currentPrice;
      const buyCondition = level.side === 'buy' && level.price < currentPrice;
      result = sellCondition || buyCondition;
      
      console.log(`🧐 [DEBUG] shouldPlaceOrder() SHORT - sellCondition: ${sellCondition} (${level.side}==='sell' && ${level.price}>${currentPrice})`);
      console.log(`🧐 [DEBUG] shouldPlaceOrder() SHORT - buyCondition: ${buyCondition} (${level.side}==='buy' && ${level.price}<${currentPrice})`);
      console.log(`🧐 [DEBUG] shouldPlaceOrder() SHORT - result: ${result}`);
    }
    
    return result;
  }

  /**
   * Colocar orden en un nivel de grid
   * ⚠️ ACTUALIZADO: usar nuevo createOrder con validación min_notional
   */
  async placeGridOrder(level: GridLevel): Promise<void> {
    console.log(`📝 [DEBUG] placeGridOrder() INICIADO - Bot: ${this.bot.id}, Level: ${level.level_index}`);
    console.log(`📝 [DEBUG] placeGridOrder() - Orden: ${level.side} ${level.quantity} ${this.bot.pair} @ $${level.price}`);
    
    try {
      // ⚠️ VALIDAR MIN_NOTIONAL antes de colocar orden
      const notional = level.quantity * level.price;
      const minNotional = this.bot.pair === 'ETH_USDT_Perp' ? 20 : 100; // ETH: $20, BTC: $100
      
      if (notional < minNotional) {
        console.log(`⚠️ [DEBUG] SKIP nivel ${level.level_index}: notional $${notional.toFixed(2)} < min_notional $${minNotional}`);
        return;
      }

      console.log(`✅ [DEBUG] Min_notional OK: $${notional.toFixed(2)} >= $${minNotional}`);

      // 🧪 DRY RUN MODE: Solo loguear las órdenes que se colocarían
      if (process.env.DRY_RUN === 'true') {
        console.log(`🧪 [DRY RUN] ORDEN QUE SE COLOCARÍA: ${level.side.toUpperCase()} ${level.quantity} ${this.bot.pair} @ $${level.price} (nivel ${level.level_index}) [notional: $${notional.toFixed(2)}]`);
        
        // En dry run, crear orden fake en database para testing
        const fakeOrderId = `dry_run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log(`📝 [DEBUG] DRY RUN - Creando orden fake en DB: ${fakeOrderId}`);
        
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

        console.log(`✅ [DEBUG] DRY RUN - Orden fake creada exitosamente`);
        return;
      }

      // 💰 MODO REAL: Colocar orden en GRVT usando nuevo formato
      console.log(`💰 [DEBUG] REAL MODE - Enviando orden a GRVT con nuevo createOrder...`);
      
      const order = await grvtClient.createOrder({
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

      console.log(`💰 [DEBUG] REAL MODE - Respuesta de GRVT createOrder:`, order);

      // Si GRVT devuelve 0x00, buscar el order_id real en open_orders
      let realOrderId = order.order_id;
      if (realOrderId === '0x00' || realOrderId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        // Esperar 1 segundo para que GRVT procese
        await new Promise(r => setTimeout(r, 1000));
        
        // Buscar la orden por precio en open_orders
        const openOrders = await grvtClient.getOpenOrders(this.bot.pair);
        const match = openOrders.find((o: any) => {
          const orderPrice = o.legs?.[0]?.limit_price ? parseFloat(o.legs[0].limit_price) : 0;
          return Math.abs(orderPrice - level.price) < 1.0;
        });
        if (match) {
          realOrderId = match.order_id;
          console.log(`[0x00 FIX] Replaced 0x00 with real order_id: ${realOrderId.slice(0,20)}... @ $${level.price}`);
        } else {
          realOrderId = `temp_${Date.now()}_${level.price}_${Math.random().toString(36).slice(2,8)}`;
          console.log(`[0x00 FIX] Generated temp ID: ${realOrderId} for $${level.price}`);
        }
      }

      // Guardar realOrderId en database, NO order.order_id
      const uniqueOrderId = order.metadata || `grid_${this.bot.id}_${level.level_index}_${Date.now()}`;
      console.log(`📝 [DEBUG] REAL MODE - Guardando orden en DB con real order_id: ${realOrderId}`);
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

      console.log(`📝 ✅ Orden creada: ${level.side} ${level.quantity} ${this.bot.pair} @ $${level.price} (ID: ${realOrderId}) [notional: $${notional.toFixed(2)}]`);

    } catch (error) {
      console.error(`❌ [DEBUG] Error colocando orden en nivel ${level.level_index}:`, error);
      console.error(`❌ [DEBUG] Error stack:`, error instanceof Error ? error.stack : String(error));
      
      // ⚠️ NUEVO: Capturar error 7201 específicamente
      if (error instanceof Error && error.message.includes('7201')) {
        console.log(`⏸️ Nivel ${level.level_index} ($${level.price}) fuera del price band — pendiente hasta que el precio se acerque`);
        await db.markLevelPendingReplace(level.id);
        return; // NO reintentar, NO propagar como error fatal
      }
      
      // Si el error es min_notional, no propagarlo como error fatal
      if (error instanceof Error && error.message.includes('min_notional')) {
        console.log(`⚠️ [DEBUG] Min_notional error - skipping nivel ${level.level_index}`);
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
    const openOrders = await grvtClient.getOpenOrders(this.bot.pair);
    
    // 2. Get current price from the last ticker
    const ticker = await grvtClient.getTicker(this.bot.pair);
    const currentPrice = parseFloat(ticker.last_price);
    
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
    
    console.log(`📊 Monitor: ${openOrders.length} GRVT, ${uncoveredLevels.length} uncovered, price $${currentPrice.toFixed(2)}`);
    
    if (uncoveredLevels.length > 0) {
      // Closest uncovered = natural gap
      const gap = uncoveredLevels[0]!;
      console.log(`🕳️ Gap: $${gap.level.price} (dist=$${gap.dist.toFixed(2)})`);
      await db.updateGridLevel(gap.level.id, { is_filled: true, order_id: '' });
    }
    
    if (uncoveredLevels.length > 1 && openOrders.length < 94) {
      // Check fill_history ONCE for recent fills (last 90s)
      const recentFills = await grvtClient.getFillHistory(50, this.bot.pair!);
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
            console.log(`✅ Fill confirmed: ${uc.level.side} @ $${uc.level.price}`);
            filledLevels.push(uc.level);
          }
          continue;
        }
        
        // Not a fill — re-place (only if GRVT count allows)
        const correctSide: 'buy' | 'sell' = uc.price < currentPrice ? 'buy' : 'sell';
        // Fixed qty: same for ALL levels (calculated from midpoint price)
        const newQty = this.getFixedQty();
        console.log(`⚠️ Re-placing: ${correctSide} ${newQty} ETH @ $${uc.level.price}`);
        try {
          await db.updateGridLevel(uc.level.id, { order_id: '0x00', is_filled: false, side: correctSide, quantity: newQty });
          uc.level.side = correctSide;
          uc.level.quantity = newQty;
          await this.placeGridOrder(uc.level);
          console.log(`✅ Placed: ${correctSide} @ $${uc.level.price}`);
        } catch (e) {
          console.log(`❌ Failed: $${uc.level.price}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    
    // 5.5 DUPLICATE KILLER: if >93 orders, cancel extras
    if (openOrders.length > 93) {
      console.log(`🔴 ${openOrders.length} orders — killing duplicates`);
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
              await grvtClient.cancelOrder(ords[i].order_id, this.bot.pair);
              console.log(`🗑️ Killed dupe @ $${price}`);
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
        console.log(`⚠️ No counter level found for index ${counterLevelIndex}, skipping`);
        continue;
      }
      
      // ⚠️ CHECK: Si el nivel destino YA tiene orden activa, NO colocar otra (evita duplicados)
      if (counterLevel.order_id && counterLevel.order_id !== '0x00' && counterLevel.order_id !== '0x0000000000000000000000000000000000000000000000000000000000000000' && !counterLevel.is_filled) {
        console.log(`⚠️ Counter level ${counterLevelIndex} @ $${counterLevel.price} already has order ${counterLevel.order_id}, skipping duplicate`);
        // Solo marcar el filled level como filled
        await db.updateGridLevel(level.id, { is_filled: true });
        continue;
      }
      
      // Fixed qty: same for ALL levels (calculated from midpoint price)
      const finalQty = this.getFixedQty();
      
      console.log(`🔄 Round-trip: ${level.side} filled @ $${level.price} → placing ${counterSide} ${finalQty} ETH @ $${counterLevel.price} (level ${counterLevelIndex})`);
      
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
          console.log(`⚠️ Skipping level ${counterLevelIndex}: ${err.message}`);
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
      console.log(`🔄 Fill ${orderId} ya procesado, skipeando...`);
      return;
    }
    
    // Marcar como procesado INMEDIATAMENTE
    this.processedFills.add(fillKey);
    
    // ⚠️ PRIMERO: remover de activeOrders para no re-detectar
    this.activeOrders.delete(orderId);
    
    try {
      // ⚠️ FIX: Obtener fills reales de GRVT para extraer fees
      let realFills: any[] = [];
      let totalFees = 0;
      try {
        const fillHistory = await grvtClient.getFillHistory(50, this.bot.pair);
        // Buscar fills que corresponden a esta orden (por client_order_id o timestamp cercano)
        const orderTrackingId = order.metadata || orderId;
        realFills = fillHistory.filter(fill => {
          return fill.client_order_id === orderTrackingId || 
                 fill.order_id === order.order_id ||
                 (Math.abs(new Date((fill as any).timestamp || fill.created_time * 1000).getTime() - Date.now()) < 60000 && 
                  Math.abs(parseFloat(fill.price) - (order.price || 0)) < 0.5);
        });
        
        totalFees = realFills.reduce((sum, fill) => sum + parseFloat(fill.fee), 0);
        console.log(`💰 [DEBUG] Fills encontrados para orden ${orderId}: ${realFills.length}, fees total: ${totalFees}`);
        
      } catch (fillErr) {
        console.log(`⚠️ Error obteniendo fills de GRVT: ${fillErr}, usando fee=0`);
      }

      // Marcar grid level como completado
      if (order.grid_level_id) {
        await db.fillGridLevel(order.grid_level_id, orderId);
      }

      // Actualizar status en database
      try { await db.updateOrderStatus(orderId, 'filled'); } catch(e) { /* ignore if not found */ }

      console.log(`✅ Orden filled: ${order.side} ${order.quantity} @ $${order.price} (fee: ${totalFees})`);

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
            console.log(`💾 Trade registrado: ${fill.is_buyer ? 'buy' : 'sell'} ${fill.size} @ ${fill.price} [fee: ${fill.fee}]`);
          } catch (tradeErr) {
            console.log(`⚠️ Error guardando trade individual: ${tradeErr}`);
          }
        }
      }

      // Colocar orden inversa en el siguiente nivel (round-trip)
      // Retry con delay si rate limited
      await this.placeCounterOrderWithRetry(order);

    } catch (error) {
      console.error(`❌ Error manejando orden completada ${orderId}:`, error);
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
          console.log(`⏸️ Error 7201 (price protection band) - NO reintentar, marcar como pendiente`);
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
            console.log(`⏳ Post-only rejected (would be taker), retry ${attempt}/${retries} en ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // After all retries, mark as pending so monitor picks it up later
          console.log(`⏸️ Post-only rejected after ${retries} retries, marcando pendiente`);
          if (order.grid_level_id) {
            await db.markLevelPendingReplace(order.grid_level_id);
          }
          return;
        }

        // Manejo específico para "Max open orders exceeded" (429/2090)
        if (msg.includes('429') && msg.includes('2090')) {
          if (attempt < retries) {
            console.log(`⚠️ Max open orders exceeded (${msg}), verificando espacio...`);
            
            try {
              // Verificar cuántas órdenes abiertas tenemos
              const openOrders = await grvtClient.getOpenOrders();
              const orderCount = openOrders.length;
              
              console.log(`📊 Órdenes abiertas: ${orderCount}/100`);
              
              if (orderCount >= 100) {
                console.log(`❌ Sin espacio para nuevas órdenes (${orderCount}/100)`);
                throw new Error(`Max orders limit reached: ${orderCount}/100`);
              }
              
              // Esperar más tiempo para max orders (10s)
              const delay = 10000;
              console.log(`⏳ Esperando ${delay}ms antes de reintentar (${attempt}/${retries})...`);
              await new Promise(r => setTimeout(r, delay));
            } catch (verifyError) {
              console.error(`❌ Error verificando órdenes abiertas:`, verifyError);
              throw error; // Lanzar error original si no podemos verificar
            }
          } else {
            throw error;
          }
        } else if (msg.includes('429') && attempt < retries) {
          // Rate limit genérico
          const delay = attempt * 2000; // 2s, 4s, 6s
          console.log(`⏳ Rate limited, retry ${attempt}/${retries} en ${delay}ms...`);
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
    console.log(`🔄 [DEBUG] Bot ${this.bot.id}: ROUND-TRIP para orden ${completedOrder.order_id} (${completedOrder.side} @ $${completedOrder.price})`);

    // Encontrar nivel actual
    const currentLevel = this.gridLevels.find(l => l.id === completedOrder.grid_level_id);
    if (!currentLevel) {
      console.log(`❌ [DEBUG] Bot ${this.bot.id}: No se encontró nivel actual para orden ${completedOrder.order_id}`);
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
      console.log(`⚠️ No counter level at index ${counterLevelIndex}, skipping`);
      return;
    }

    // Fixed qty: same for ALL levels (calculated from midpoint price)
    const qty = this.getFixedQty();
    
    console.log(`🔄 Round-trip: ${completedOrder.side} filled @ $${currentLevel.price} → placing ${counterSide} ${qty} ETH @ $${nextLevel.price} (level ${counterLevelIndex})`);

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
        console.log(`💰 Round-trip profit: $${rtProfit.toFixed(4)} (spread $${spread.toFixed(2)} × ${qty} ETH)`);
      } catch (rtErr) {
        console.log(`⚠️ Error recording round-trip profit: ${rtErr}`);
      }
      
      console.log(`✅ Round-trip placed: ${counterSide} @ $${nextLevel.price}`);
    } catch (error) {
      console.error(`❌ Round-trip error @ $${nextLevel.price}:`, error instanceof Error ? error.message : error);
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
      const ticker = await grvtClient.getTicker(this.bot.pair);
      const currentPrice = parseFloat(ticker.last_price);

      console.log(`🔍 Revisando ${pendingLevels.length} niveles pendientes (precio actual: $${currentPrice})`);

      for (const level of pendingLevels) {
        // Verificar si el precio actual está dentro del ~10% del nivel
        const priceDistance = Math.abs(level.price - currentPrice) / currentPrice;
        const withinRange = priceDistance <= 0.50; // 50% tolerance - increased for grid orders

        if (withinRange) {
          console.log(`🎯 Nivel ${level.level_index} ($${level.price}) dentro del rango — intentando colocar`);
          
          try {
            // Intentar colocar la orden
            await this.placeGridOrder(level);
            
            // Si exitoso, limpiar pending_replace
            await db.clearLevelPendingReplace(level.id);
            
            console.log(`✅ Nivel ${level.level_index} colocado exitosamente y removido de pending`);
            
            // Throttle entre órdenes pendientes
            await new Promise(r => setTimeout(r, 300));
            
          } catch (error) {
            if (error instanceof Error && error.message.includes('7201')) {
              // Aún fuera del price band, mantener como pendiente
            } else if (error instanceof Error && error.message.includes('2090')) {
              console.log(`⚠️ Max orders reached, stopping pending replacements`);
              return; // STOP - don't try more
            } else {
              console.error(`❌ Error colocando nivel pendiente ${level.level_index}:`, error instanceof Error ? error.message : error);
            }
          }
        }
        // Si no está dentro del rango, skip silenciosamente (sin log spam)
      }
      
    } catch (error) {
      console.error(`❌ Error verificando niveles pendientes:`, error);
    }
  }

  /**
   * Actualizar PnL del bot
   */
  private pnlUpdateCounter: number = 0;

  private async updatePnL(): Promise<void> {
    try {
      // Obtener posición actual
      const position = await grvtClient.getPosition(this.bot.pair);
      
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
          console.log(`📊 [DEBUG] Calculando grid profit real desde GRVT fills...`);
          const realGridProfit = await this.calculateRealGridProfit();
          console.log(`📊 [DEBUG] Grid profit real calculado: ${realGridProfit}`);
          if (realGridProfit !== null) {
            this.bot.grid_profit_usdt = realGridProfit;
          }
        } catch (gpErr) {
          console.log(`⚠️ [DEBUG] Error calculando grid profit real: ${gpErr}`);
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
      console.error(`❌ Error actualizando PnL bot ${this.bot.id}:`, error);
    }
  }

  /**
   * Calcular grid profit REAL desde fills de GRVT
   * Parea buys con sells a ~gridSpacing de distancia
   */
  private async calculateRealGridProfit(): Promise<number | null> {
    try {
      const fills = await grvtClient.getFillHistory(1000);
      if (!fills || fills.length === 0) return null;

      // Sort chronologically (oldest first) for correct pairing
      const sorted = [...fills].sort((a: any, b: any) => 
        parseInt(a.event_time) - parseInt(b.event_time)
      );

      let totalFees = 0;
      let grossProfit = 0;
      let pairs = 0;
      const pendingBuys: Array<{price: number, size: number}> = [];
      let totalBuys = 0;
      let totalSells = 0;

      sorted.forEach((f: any) => {
        const price = parseFloat(f.price);
        const size = parseFloat(f.size);
        const fee = Math.abs(parseFloat(f.fee));
        totalFees += fee;

        if (f.is_buyer) {
          totalBuys++;
          pendingBuys.push({price, size});
        } else {
          totalSells++;
          // Find best pending buy to pair: closest price BELOW this sell, min $3 spread
          let bestIdx = -1;
          let bestSpread = Infinity;
          pendingBuys.forEach((b, i) => {
            const spread = price - b.price;
            if (spread > 3 && spread < 20 && spread < bestSpread) {
              bestIdx = i;
              bestSpread = spread;
            }
          });
          if (bestIdx >= 0) {
            const b = pendingBuys[bestIdx]!;
            grossProfit += (price - b.price) * size;
            pairs++;
            pendingBuys.splice(bestIdx, 1);
          }
        }
      });

      const netProfit = grossProfit - totalFees;
      console.log(`📊 [DEBUG] Fills: ${fills.length}, Buys: ${totalBuys}, Sells: ${totalSells}, Fees: ${totalFees.toFixed(4)}`);
      console.log(`📊 [DEBUG] Grid pairs: ${pairs}, Gross: $${grossProfit.toFixed(2)}, Net: $${netProfit.toFixed(2)}`);
      
      return netProfit;

    } catch (error) {
      return null;
    }
  }

  /**
   * SAFEGUARD: Verificar pérdida máxima (-20% del capital)
   */
  private async checkMaxLoss(): Promise<void> {
    const maxLossThreshold = this.bot.investment_usdt * -0.20; // -20%
    
    if (this.bot.total_pnl_usdt < maxLossThreshold) {
      console.log(`🚨 SAFEGUARD: Bot ${this.bot.id} alcanzó pérdida máxima: $${this.bot.total_pnl_usdt}`);
      throw new Error(`SAFEGUARD: Pérdida máxima alcanzada (-20% del capital)`);
    }
  }

  /**
   * Obtener grid profit real calculado para un bot específico (público para dashboard)
   */
  async getRealGridProfitForBot(botId: number): Promise<number | null> {
    const bot = await db.getBot(botId);
    if (!bot) {
      console.warn(`⚠️ Bot ${botId} no encontrado para calcular grid profit`);
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
    const cancelledCount = await grvtClient.cancelAllOrders(this.bot.pair);
    this.activeOrders.clear();
    
    console.log(`❌ ${cancelledCount} órdenes canceladas para bot ${this.bot.id}`);
  }

  /**
   * Configurar daily snapshots para ejecutar cada 24h a las 00:00 UTC
   */
  private setupDailySnapshots(): void {
    // Calcular tiempo hasta las próximas 00:00 UTC
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    console.log(`📸 Daily snapshots configurados - próximo en ${Math.round(msUntilMidnight / 1000 / 3600)} horas`);
    
    // Configurar timeout para la primera ejecución (a medianoche)
    setTimeout(() => {
      // Crear snapshot inmediatamente a medianoche
      this.createDailySnapshots().catch(console.error);
      
      // Luego configurar interval cada 24h
      (this as any).dailySnapshotInterval = setInterval(() => {
        this.createDailySnapshots().catch(console.error);
      }, 24 * 60 * 60 * 1000); // 24 horas
      
    }, msUntilMidnight);
  }

  /**
   * Crear snapshots diarios para todos los bots activos
   */
  private async createDailySnapshots(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      console.log(`📸 Creando daily snapshots para ${today}...`);
      
      // Obtener precio actual de ETH
      let ethPrice: number | null = null;
      try {
        const tickers = await grvtClient.getTickers(['ETH_USDT_Perp']);
        if (tickers && tickers.length > 0 && tickers[0]?.last_price) {
          ethPrice = parseFloat(tickers[0].last_price);
        }
      } catch (e) {
        console.warn('⚠️ No se pudo obtener precio de ETH para snapshot');
      }
      
      // Crear snapshot para el bot actual
      const currentBot = this.bot;
      if (currentBot?.id) {
        const botId: number = currentBot.id;
        try {
          // Verificar si ya existe snapshot para hoy
          const exists = await db.hasSnapshotForDate(botId, today as string);
          if (exists) {
            console.log(`📸 Snapshot ya existe para bot ${botId} fecha ${today}`);
            return;
          }
          
          // Obtener balance actual
          const balance = await grvtClient.getBalance();
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
          
          console.log(`📸 Snapshot creado para bot ${botId}: equity=$${equity}, grid_profit=$${gridProfitNet}, round_trips=${roundTrips}`);
          
        } catch (error) {
          console.error(`❌ Error creando snapshot para bot ${botId}:`, error);
        }
      }
      
      console.log(`✅ Daily snapshots completados para ${today}`);
      
    } catch (error) {
      console.error('❌ Error en createDailySnapshots:', error);
    }
  }

}

// Instancia singleton del Grid Engine
export const gridEngine = new GridEngine();

export default gridEngine;