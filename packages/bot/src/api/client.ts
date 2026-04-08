// GRVT API Client - Fase 3
// Wrapper completo para todas las llamadas a GRVT
// Métodos: balance, positions, orders, fills, funding, leverage, etc.

import { authenticatedRequest, publicRequest } from './auth.js';
import { signOrder, formatSignedOrderForAPI } from './order-signer.js';
import dotenv from 'dotenv';

dotenv.config();

// Endpoints GRVT verificados por Marta
const MARKET_DATA_URL = 'https://market-data.grvt.io/full/v1';
const TRADING_URL = 'https://trades.grvt.io/full/v1';

// Tipos para las respuestas de la API
export interface Balance {
  sub_account_id: string;
  total_equity: string;
  available_balance: string;
  margin_used: string;
  maintenance_margin: string;
  initial_margin: string;
  currency: string;
}

export interface Position {
  sub_account_id: string;
  instrument: string;
  size: string;
  notional: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  side: 'buy' | 'sell';
  leverage: string;
  liquidation_price: string;
  margin_used: string;
  funding_payment: string;
}

export interface Order {
  order_id: string;
  sub_account_id: string;
  instrument: string;
  size: string;
  filled_size: string;
  price: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  time_in_force: 'gtc' | 'ioc' | 'fok';
  created_time: number;
  updated_time: number;
  metadata?: string;
}

export interface Fill {
  fill_id: string;
  order_id: string;
  sub_account_id: string;
  instrument: string;
  size: string;
  price: string;
  side: 'buy' | 'sell';
  fee: string;
  fee_currency: string;
  liquidity: 'maker' | 'taker';
  created_time: number;
  trade_id: string;
  event_time?: string;
  is_buyer?: boolean;
  is_taker?: boolean;
  client_order_id?: string;
  realized_pnl?: string;
}

export interface CreateOrderRequest {
  sub_account_id: string;
  instrument: string;
  size: string;
  price?: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  time_in_force?: 'gtc' | 'ioc' | 'fok';
  post_only?: boolean;
  metadata?: string;
}

export interface KlineCandle {
  openTime: number;   // unix milliseconds
  closeTime: number;  // unix milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;     // base volume
  trades: number;
}

export interface FundingPayment {
  sub_account_id: string;
  instrument: string;
  funding_rate: string;
  payment: string;
  position_size: string;
  funding_time: number;
}

export interface Ticker {
  instrument: string;
  last_price: string;
  best_bid: string;
  best_ask: string;
  open_price: string;
  high_price: string;
  low_price: string;
  volume_24h: string;
  buy_volume_24h_q: string;
  sell_volume_24h_q: string;
  funding_rate: string;
  next_funding_time: number;
  mark_price: string;
}

// Rate limiting: max 10 requests/segundo según specs
class RateLimiter {
  private requests: number[] = [];
  private maxRequests = 10;
  private timeWindow = 1000; // 1 segundo

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    
    // Remover requests viejos (fuera de ventana)
    this.requests = this.requests.filter(time => now - time < this.timeWindow);
    
    // Si estamos en el límite, esperar
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      if (oldestRequest) {
        const waitTime = this.timeWindow - (now - oldestRequest) + 50; // +50ms safety
        
        if (waitTime > 0) {
          console.log(`⏳ Rate limit: esperando ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    // Registrar nueva request
    this.requests.push(now);
  }
}

const rateLimiter = new RateLimiter();

/**
 * GRVT API Client Class
 */
export class GRVTClient {
  private tradingAccountId: string;

  constructor() {
    // MOCK_MODE / DRY_RUN: allow the bot to boot without real GRVT
    // credentials so self-hosters can take a tour of the dashboard before
    // they have an account, and so the docker image can be smoke-tested in
    // CI without secrets. The engine layer (grid-engine.ts) already checks
    // MOCK_MODE to short-circuit any path that would actually call GRVT,
    // so the dummy account id never reaches the wire.
    const isMockMode = process.env.MOCK_MODE === 'true' || process.env.DRY_RUN === 'true';
    this.tradingAccountId = process.env.GRVT_TRADING_ACCOUNT_ID || (isMockMode ? 'mock-account' : '');
    if (!this.tradingAccountId) {
      throw new Error('GRVT_TRADING_ACCOUNT_ID no encontrado en .env (set MOCK_MODE=true to bypass for development)');
    }
  }

  // === MARKET DATA (público) ===

  /**
   * Obtener ticker para un instrumento
   */
  async getTicker(instrument: string): Promise<Ticker> {
    const data = await publicRequest(`${MARKET_DATA_URL}/ticker`, {
      instrument
    });
    return data;
  }

  /**
   * Obtener múltiples tickers
   */
  async getTickers(instruments: string[]): Promise<Ticker[]> {
    const promises = instruments.map(instrument => this.getTicker(instrument));
    return Promise.all(promises);
  }

  /**
   * Obtener instrumentos disponibles
   */
  async getInstruments(): Promise<any[]> {
    const data = await publicRequest(`${MARKET_DATA_URL}/instruments`, {});
    return data;
  }

  /**
   * Get historical kline (candlestick) data for an instrument.
   *
   * GRVT's kline endpoint quirks:
   *   - Required field `type` must be "TRADE" (no other modes used in production).
   *   - `interval` uses GRVT's CI_<n>_<unit> enum (e.g. "CI_1_M", "CI_1_H",
   *     "CI_4_H", "CI_1_D"). NOT "1h" / "1m".
   *   - `open_time` / `close_time` come back as **nanosecond strings**
   *     (not millis, not numbers). The dashboard divides by 1e6 to render.
   *   - `start_time` / `end_time` go in as nanoseconds too if provided.
   *   - The API returns rows in **reverse chronological order** (newest first).
   *     The chart wants ascending, so the v2-router reverses before sending.
   */
  async getKlines(
    instrument: string,
    interval: string = 'CI_1_H',
    limit: number = 500
  ): Promise<KlineCandle[]> {
    const data = await publicRequest(`${MARKET_DATA_URL}/kline`, {
      instrument,
      interval,
      type: 'TRADE',
      limit
    });
    // publicRequest already unwraps `.result` from the GRVT envelope, so
    // `data` is normally the rows array. But if GRVT ever returns the
    // wrapped object directly we still want to handle it — accept both.
    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.result)
        ? data.result
        : [];
    return rows.map((row): KlineCandle => ({
      openTime: Number(row.open_time) / 1_000_000, // ns string -> ms
      closeTime: Number(row.close_time) / 1_000_000,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume_b ?? '0'),
      trades: Number(row.trades ?? 0)
    }));
  }

  // === TRADING API (autenticado) ===

  /**
   * Obtener balance de la cuenta trading
   */
  async getBalance(): Promise<Balance> {
    await rateLimiter.waitIfNeeded();
    
    const data = await authenticatedRequest(`${TRADING_URL}/account_summary`, {
      sub_account_id: this.tradingAccountId
    });
    
    return {
      sub_account_id: this.tradingAccountId,
      total_equity: data.total_equity || '0',
      available_balance: data.available_balance || '0',
      margin_used: data.margin_used || '0',
      maintenance_margin: data.maintenance_margin || '0',
      initial_margin: data.initial_margin || '0',
      currency: 'USDT'
    };
  }

  /**
   * Obtener todas las posiciones
   */
  async getPositions(): Promise<Position[]> {
    await rateLimiter.waitIfNeeded();
    
    const data = await authenticatedRequest(`${TRADING_URL}/positions`, { sub_account_id: this.tradingAccountId });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Obtener posición específica
   */
  async getPosition(instrument: string): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find(p => p.instrument === instrument) || null;
  }

  /**
   * Obtener órdenes abiertas
   */
  async getOpenOrders(instrument?: string): Promise<Order[]> {
    await rateLimiter.waitIfNeeded();
    
    const body: any = { sub_account_id: this.tradingAccountId };
    if (instrument) {
      body.instrument = instrument;
    }
    
    const data = await authenticatedRequest(`${TRADING_URL}/open_orders`, body);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Crear orden con firma EIP-712 (LIMIT para grid, MARKET para compra inicial/cierre)
   * ⚠️ ACTUALIZADO: endpoint /full/v1/create_order con formato verificado
   */
  async createOrder(request: CreateOrderRequest, allowMarket: boolean = false): Promise<Order> {
    await rateLimiter.waitIfNeeded();
    
    // SAFEGUARD: Solo órdenes LIMIT excepto casos especiales (compra inicial/cierre)
    if (request.type !== 'limit' && !allowMarket) {
      throw new Error('SAFEGUARD: Solo se permiten órdenes LIMIT (usar allowMarket=true para casos especiales)');
    }

    // SAFEGUARD: Validar min_size y min_notional
    this.validateOrderSize(request.instrument, request.size, request.price!);

    console.log(`📝 Creando orden: ${request.side} ${request.size} ${request.instrument} @ ${request.price}`);
    
    try {
      // Firmar orden con EIP-712
      const signedOrder = await signOrder({
        instrument: request.instrument,
        side: request.side,
        size: request.size,
        price: request.price!,
        postOnly: request.post_only || false,
      });

      // Formatear para API de GRVT
      const orderData = formatSignedOrderForAPI(
        signedOrder,
        request.instrument,
        request.size,
        request.price!,
        request.side
      );

      console.log('🔏 Orden firmada, enviando a GRVT...');
      
      // ⚠️ CAMBIO: endpoint /full/v1/create_order
      const data = await authenticatedRequest(`${TRADING_URL}/create_order`, orderData);
      
      console.log('✅ Respuesta GRVT createOrder:', data);
      
      // ⚠️ CAMBIO: respuesta contiene order_id en result
      // Extraer client_order_id del request enviado para tracking
      const clientOrderId = orderData?.order?.metadata?.client_order_id || String(Date.now());
      return {
        order_id: data.result?.order_id || data.order_id,
        sub_account_id: request.sub_account_id,
        instrument: request.instrument,
        size: request.size,
        filled_size: '0',
        price: request.price || '0',
        side: request.side,
        type: request.type,
        status: 'open',
        time_in_force: request.time_in_force || 'gtc',
        created_time: Date.now(),
        updated_time: Date.now(),
        metadata: clientOrderId
      } as Order;

    } catch (error) {
      console.error('❌ Error creando orden firmada:', error);
      throw error;
    }
  }

  /**
   * Cancelar orden específica
   */
  async cancelOrder(orderId: string, instrument: string): Promise<boolean> {
    await rateLimiter.waitIfNeeded();
    
    console.log(`❌ Cancelando orden: ${orderId}`);
    
    try {
      await authenticatedRequest(`${TRADING_URL}/cancel_order`, {
        sub_account_id: this.tradingAccountId,
        order_id: orderId,
        instrument: instrument
      });
      return true;
    } catch (error) {
      console.error(`Error cancelando orden ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Cancelar todas las órdenes (por instrumento o todas)
   */
  async cancelAllOrders(instrument?: string): Promise<number> {
    await rateLimiter.waitIfNeeded();
    
    console.log(instrument ? 
      `❌ Cancelando todas las órdenes de ${instrument}` :
      '❌ Cancelando TODAS las órdenes'
    );

    const body: any = { sub_account_id: this.tradingAccountId };
    if (instrument) {
      body.instrument = instrument;
    }

    try {
      const data = await authenticatedRequest(`${TRADING_URL}/cancel_all_orders`, body);
      const cancelledCount = data.cancelled_count || 0;
      console.log(`✅ ${cancelledCount} órdenes canceladas`);
      return cancelledCount;
    } catch (error) {
      console.error('Error cancelando órdenes:', error);
      return 0;
    }
  }

  /**
   * Establecer leverage para un instrumento
   */
  async setLeverage(instrument: string, leverage: number): Promise<boolean> {
    await rateLimiter.waitIfNeeded();
    
    console.log(`⚡ Estableciendo leverage ${leverage}x para ${instrument}`);
    
    try {
      await authenticatedRequest(`${TRADING_URL}/set_leverage`, {
        sub_account_id: this.tradingAccountId,
        instrument: instrument,
        leverage: leverage.toString()
      });
      return true;
    } catch (error) {
      console.error(`Error estableciendo leverage:`, error);
      return false;
    }
  }

  /**
   * Obtener historial de fills (últimas N transacciones).
   *
   * `endTimeNs` is optional and lets a caller page backwards: pass the
   * oldest event_time of a previous batch to get fills strictly older
   * than that. GRVT returns fills ordered newest→oldest, so the typical
   * backfill loop is:
   *
   *   const all = [];
   *   let endTime: string | undefined = undefined;
   *   while (true) {
   *     const batch = await getFillHistory(1000, instrument, endTime);
   *     if (batch.length === 0) break;
   *     all.push(...batch);
   *     const oldest = batch[batch.length - 1];
   *     // Subtract 1 ns so the next batch is strictly before this one,
   *     // avoiding an infinite loop on the boundary fill.
   *     endTime = (BigInt(oldest.event_time) - 1n).toString();
   *     if (batch.length < 1000) break;  // last page
   *   }
   *
   * If GRVT silently ignores `end_time`, the loop will see the same
   * batch again and INSERT OR IGNORE in fills_archive will be a no-op,
   * but the loop will spin — the caller is responsible for an
   * iteration cap.
   */
  async getFillHistory(
    limit: number = 100,
    instrument?: string,
    endTimeNs?: string
  ): Promise<Fill[]> {
    await rateLimiter.waitIfNeeded();

    const body: any = {
      sub_account_id: this.tradingAccountId,
      limit: Math.min(limit, 1000)
    };

    if (instrument) {
      body.instrument = instrument;
    }
    if (endTimeNs) {
      body.end_time = endTimeNs;
    }

    const data = await authenticatedRequest(`${TRADING_URL}/fill_history`, body);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Obtener historial de funding payments
   * ⚠️ FIX: GRVT usa POST para funding_history según specs
   */
  async getFundingHistory(limit: number = 100, instrument?: string): Promise<FundingPayment[]> {
    await rateLimiter.waitIfNeeded();
    
    const body: any = {
      sub_account_id: this.tradingAccountId,
      limit: Math.min(limit, 1000)
    };
    
    if (instrument) {
      body.instrument = instrument;
    }

    try {
      // ⚠️ FIX: funding_history endpoint da 404, usar account_summary en su lugar
      console.log(`📡 [DEBUG] Getting funding from account_summary (funding_history no disponible)...`);
      
      // Obtener account_summary que incluye cumulative_realized_funding_payment
      const data = await authenticatedRequest(`${TRADING_URL}/account_summary`, {
        sub_account_id: this.tradingAccountId
      });
      
      const fundingPayments: FundingPayment[] = [];
      
      // Extraer funding de cada posición
      if (data.positions && Array.isArray(data.positions)) {
        for (const position of data.positions) {
          if (position.cumulative_realized_funding_payment !== undefined) {
            const fundingAmount = parseFloat(position.cumulative_realized_funding_payment || '0');
            
            // Filtrar por instrumento si se especifica
            if (!instrument || position.instrument === instrument) {
              fundingPayments.push({
                sub_account_id: this.tradingAccountId,
                instrument: position.instrument,
                funding_rate: '0', // No disponible en summary
                // BUG FIX: grid-engine.ts treats funding_time as SECONDS and
                // does `payment.funding_time * 1000` to convert to ms before
                // building a Date. Date.now() returns ms, so the *1000 was
                // turning ms into μs → year 058236 in the stored ISO string.
                // 739 rows in production were corrupted by this; backfilled
                // via SQL on deploy. New rows now correctly stamp seconds.
                funding_time: Math.floor(Date.now() / 1000),
                payment: Math.abs(fundingAmount).toString(), // Valor absoluto
                position_size: position.size || '0'
              });
              
              console.log(`📡 [DEBUG] Funding for ${position.instrument}: ${fundingAmount} USDT`);
            }
          }
        }
      }
      
      console.log(`📡 [DEBUG] Total funding payments found: ${fundingPayments.length}`);
      return fundingPayments;
      
    } catch (error) {
      console.error('Error obteniendo funding desde account_summary:', error);
      return [];
    }
  }

  // === VALIDACIONES Y SAFEGUARDS ===

  /**
   * Validar tamaño de orden según specs de instrumento
   */
  private validateOrderSize(instrument: string, size: string, price: string): void {
    const sizeNum = parseFloat(size);
    const priceNum = parseFloat(price);
    const notional = sizeNum * priceNum;

    // Specs verificadas por Marta
    const instrumentSpecs: Record<string, { min_size: number; min_notional: number; tick_size: number }> = {
      'BTC_USDT_Perp': { min_size: 0.001, min_notional: 100, tick_size: 0.1 },
      'ETH_USDT_Perp': { min_size: 0.01, min_notional: 20, tick_size: 0.01 }
    };

    const specs = instrumentSpecs[instrument];
    if (!specs) {
      throw new Error(`Instrumento no soportado: ${instrument}`);
    }

    if (sizeNum < specs.min_size) {
      throw new Error(`Tamaño ${size} menor que min_size ${specs.min_size} para ${instrument}`);
    }

    if (notional < specs.min_notional) {
      throw new Error(`Notional $${notional.toFixed(2)} menor que min_notional $${specs.min_notional} para ${instrument}`);
    }

    // Validar tick size usando aritmética más precisa
    const rounded = Math.round(priceNum / specs.tick_size) * specs.tick_size;
    const diff = Math.abs(priceNum - rounded);
    const tolerance = specs.tick_size / 1000;
    if (diff >= tolerance) {
      throw new Error(`Precio ${price} no es múltiplo de tick_size ${specs.tick_size} para ${instrument} (diff: ${diff})`);
    }
  }

  /**
   * Calcular precio de liquidación aproximado
   */
  async calculateLiquidationPrice(instrument: string, leverage: number): Promise<string> {
    try {
      const position = await this.getPosition(instrument);
      if (!position) return '0';

      const entryPrice = parseFloat(position.entry_price);
      const maintenanceMarginRate = 0.005; // 0.5% típico
      
      // Aproximación: liq_price = entry_price * (1 ± (1/leverage - maintenance_margin))
      const factor = 1 / leverage - maintenanceMarginRate;
      
      let liquidationPrice: number;
      if (position.side === 'buy') {
        liquidationPrice = entryPrice * (1 - factor);
      } else {
        liquidationPrice = entryPrice * (1 + factor);
      }

      return Math.max(0, liquidationPrice).toFixed(2);

    } catch (error) {
      console.error('Error calculando liquidation price:', error);
      return '0';
    }
  }
}

// Instancia singleton del client
export const grvtClient = new GRVTClient();

export default grvtClient;