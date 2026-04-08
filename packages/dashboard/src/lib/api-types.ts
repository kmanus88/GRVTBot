// Type definitions for the v2 REST API responses.
// Mirrors packages/bot/src/server/v2-router.ts. Hand-written for now;
// promote to autogen (zod schema or openapi) when the API stabilizes.

export type BotStatus = 'running' | 'paused' | 'stopped' | 'error';

export interface BotSummary {
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
  status: BotStatus;
  position_size: number;
  avg_entry_price: number;
  liquidation_price: number | null;
  created_at: string;
  updated_at: string;
}

export interface GridLevel {
  id: number;
  level_index: number;
  price: number;
  side: 'buy' | 'sell';
  quantity: number;
  is_filled: 0 | 1;
  pending_replace: 0 | 1;
  order_id: string | null;
}

export interface GridState {
  botId: number;
  pair: string;
  status: BotStatus;
  levels: GridLevel[];
  ticker: unknown;
  position: unknown;
  openOrders: unknown[];
  ts: number;
}

export interface Trade {
  id: number;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  round_trip_profit: number | null;
  created_at: string;
}

export interface DailySnapshot {
  id: number;
  bot_id: number;
  date: string;
  equity_usdt: number;
  realized_pnl_usdt: number;
  unrealized_pnl_usdt: number;
  num_round_trips: number;
  total_fees_usdt: number;
  funding_usdt: number;
}

export interface Roundtrip {
  id: number;
  buy_fill_id: string;
  sell_fill_id: string;
  buy_price: number;
  sell_price: number;
  size: number;
  profit: number;
  created_at: string;
}

// A fill recorded by the engine's fill poller, sourced verbatim from
// GRVT's fill_history endpoint. Every field is real exchange data:
//   - `fee` is what GRVT actually charged (positive) or refunded
//     (negative — maker rebate) for THIS fill on THIS account at the
//     user's current volume tier. Different accounts pay different
//     rates; the bot is fee-agnostic and never assumes a value.
export interface FillRow {
  id: number;
  fill_id: string;     // == event_time, used as the unique key
  event_time: string;  // GRVT nanosecond timestamp
  is_buyer: 0 | 1;
  price: number;
  size: number;
  fee: number;         // signed; negative = rebate earned
  created_at: string;  // ISO from event_time
}

export interface RebateSummary {
  count: number;        // total fills observed
  sumFee: number;       // signed; negative = net rebate earned
  netRebateUsdt: number; // -sumFee; positive when user earned net
  avgFee: number;
  minFee: number;
  maxFee: number;
}

// Real grid_profit, computed by spread-pairing every fill in fills_archive
// (filtered to post-bot-creation). Same algorithm the engine uses for
// bot.grid_profit_usdt, but operating over the FULL backfilled history
// instead of just the last ~430 fills GRVT exposes per request.
//
// Why spread-pair instead of FIFO: a grid bot opens 93 simultaneous
// positions at different price levels — FIFO over the flat fill stream
// would falsely match a $1800 buy against a $2240 sell (+$440/ETH that
// never actually happened). Spread-pair only matches buys & sells whose
// price difference is within one grid spacing window.
//
// Why not equity-minus-investment: bot.investment_usdt is bumped by
// compound rebalances AND by external margin transfers, so it doesn't
// reflect original cash deposited.
export interface RealizedSummary {
  gridProfit: number;       // gross trade-pair profit
  totalFees: number;        // signed; negative = net rebate earned
  netGridProfit: number;    // gridProfit - totalFees (rebates increase net)
  pairs: number;            // matched grid round trips
  avgPerPair: number;
  fillCount: number;
  unpairedBuys: number;     // open BUY lots (≈ current position)
  unpairedSells: number;    // SELLs without matching BUY (data gap warning)
  firstFillAt: string | null;
  lastFillAt: string | null;
}

export interface OrderRow {
  id: number;
  order_id: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  quantity: number;
  price: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  grid_level_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface FundingRow {
  id: number;
  instrument: string;
  funding_rate: number;
  payment_usdt: number;
  position_size: number;
  funding_time: string;
  created_at: string;
}

export interface ValidateBotInput {
  pair: string;
  direction: 'long' | 'short';
  lower_price: number;
  upper_price: number;
  num_grids: number;
  investment_usdt: number;
  leverage: number;
}

export interface ValidateBotResult {
  valid: true;
  pair: string;
  direction: 'long' | 'short';
  input: {
    lower: number;
    upper: number;
    grids: number;
    investment: number;
    leverage: number;
  };
  computed: {
    spacing: number;
    spacingPct: number;
    qtyPerLevel: number;
    notional: number;
    profitPerRoundTrip: number;
    midPrice: number;
    liquidationEstimate: number;
    liqDistancePct: number;
  };
  warnings: string[];
}

// Kline / candlestick — both timestamps in unix MILLISECONDS (not ns).
// The bot's getKlines() already converts the GRVT ns string format.
export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export type CandleInterval =
  | 'CI_1_M'
  | 'CI_5_M'
  | 'CI_15_M'
  | 'CI_30_M'
  | 'CI_1_H'
  | 'CI_4_H'
  | 'CI_1_D';

export interface HealthV2 {
  status: 'ok';
  uptime: number;
  runningBots: number;
  cacheSize: number;
  memory: { rss: number; heapUsed: number };
  ts: number;
}

// API error envelope thrown by the client when a request fails.
export class ApiError extends Error {
  constructor(
    public status: number,
    public payload: unknown,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
