// Bot Detail page — GridChart hero + 6-card stat strip + secondary equity
// curve / stats panel + tabs for Fills/Snapshots.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Pause, Play, SlidersHorizontal, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import type {
  DailySnapshot,
  FillRow,
  FundingRow,
  GridLevel,
  GridState,
  OrderRow,
  Roundtrip,
} from '@/lib/api-types';
import { useWsChannel } from '@/lib/use-ws-channel';
import {
  formatPercent,
  formatPnl,
  formatSize,
  formatTimeUtc,
  formatUsd,
} from '@/lib/format';
import { Button } from '@/components/primitives/button';
import { Card } from '@/components/primitives/card';
import { useConfirm } from '@/components/primitives/confirm-dialog';
import { Mono } from '@/components/primitives/mono';
import { StatCard } from '@/components/primitives/stat-card';
import { StatusPill } from '@/components/primitives/status-pill';
import { Delta } from '@/components/primitives/delta';
import { Tabs } from '@/components/primitives/tabs';
import { DataTable, type Column } from '@/components/primitives/data-table';
import { EquityCurve } from '@/components/charts/equity-curve';
import { StatsPanel } from '@/components/stats-panel';
import { UpdateRangeDialog } from '@/components/update-range-dialog';
import {
  FILL_FLASH_DURATION_MS,
  GridChart,
} from '@/components/charts/grid-chart';

interface BotTick {
  id: number;
  status: 'running' | 'paused' | 'stopped' | 'error';
  positionSize: number;
  avgEntryPrice: number;
  gridProfit: number;
  trendPnl: number;
  totalPnl: number;
}

interface FillEvent {
  bot_id?: number;
  level_index?: number;
  side?: 'buy' | 'sell';
  price?: number;
}

export function BotDetailPage() {
  const { id } = useParams();
  // Parse bot id from URL. NaN here means the route was hit without a
  // valid id segment — render the error card below instead of falling
  // back to a hardcoded id (used to be 42, which leaked stale state).
  const botId = Number(id);
  const queryClient = useQueryClient();

  // Bot summary (low-frequency)
  const botQuery = useQuery({
    queryKey: ['bot', botId],
    queryFn: () => api.getBot(botId),
    staleTime: 5_000,
  });

  // Grid state — levels + ticker + position. Polled every 3s as the WS
  // dispatcher only pushes summary ticks; level state changes warrant a
  // refresh from REST.
  const gridStateQuery = useQuery<GridState>({
    queryKey: ['gridState', botId],
    queryFn: () => api.getGridState(botId),
    refetchInterval: 3_000,
  });

  // Candles — 1H, last ~7 days. Cached on the server (30s for 1H).
  const candlesQuery = useQuery({
    queryKey: ['candles', botQuery.data?.bot.pair, 'CI_1_H'],
    queryFn: () =>
      api.getCandles(botQuery.data?.bot.pair ?? 'ETH_USDT_Perp', 'CI_1_H', 200),
    enabled: !!botQuery.data?.bot.pair,
    refetchInterval: 60_000,
  });

  // Live tick from WS — overrides the REST snapshot when present.
  const [tick, setTick] = useState<BotTick | null>(null);
  useWsChannel<BotTick>(`bot:${botId}`, (msg) => {
    if (msg.type === 'tick') setTick(msg.data);
  });

  // Fill flash animation: detect levels that just transitioned filled→active
  // (or vice versa) and surface them to GridChart for ~600ms.
  const prevFilledRef = useRef<Set<number>>(new Set());
  const [recentlyFilled, setRecentlyFilled] = useState<Set<number>>(new Set());

  useEffect(() => {
    const levels = gridStateQuery.data?.levels;
    if (!levels) return;
    const currentFilled = new Set(
      levels.filter((l) => l.is_filled === 1).map((l) => l.level_index)
    );
    const prev = prevFilledRef.current;
    const transitioned: number[] = [];
    for (const idx of currentFilled) {
      if (!prev.has(idx)) transitioned.push(idx);
    }
    for (const idx of prev) {
      if (!currentFilled.has(idx)) transitioned.push(idx);
    }
    prevFilledRef.current = currentFilled;

    if (transitioned.length === 0) return;
    setRecentlyFilled(new Set(transitioned));
    const timer = window.setTimeout(() => {
      setRecentlyFilled(new Set());
    }, FILL_FLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [gridStateQuery.data?.levels]);

  // WS-driven fill events: when the bus pushes a `fill` for this bot,
  // bump the gridState query so the levels refresh immediately.
  useWsChannel<FillEvent>('fills', (msg) => {
    if (msg.type !== 'fill') return;
    if (msg.data.bot_id != null && msg.data.bot_id !== botId) return;
    void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
  });

  // ── ALL hooks must run BEFORE any early return.
  // Rules of Hooks: the order/count of hook calls must be stable across
  // every render of the same component instance. The previous version of
  // this component called useMutation x2 + useConfirm AFTER the
  // `if (botQuery.isPending) return <PageSkeleton />` early return, so
  // the hook count went from N (loading) to N+3 (loaded) and React blew
  // up the render with "rendered more hooks than during the previous
  // render". The fix is to declare every hook unconditionally up here.
  const startMutation = useMutation({
    mutationFn: () => api.startBot(botId),
    onSuccess: () => {
      toast.success(`Bot ${botId} started`);
      void queryClient.invalidateQueries({ queryKey: ['bot', botId] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
    },
    onError: (err: Error) => toast.error(`Start failed: ${err.message}`),
  });

  const pauseMutation = useMutation({
    mutationFn: () => api.pauseBot(botId),
    onSuccess: () => {
      toast.success(`Bot ${botId} paused (orders cancelled on GRVT)`);
      void queryClient.invalidateQueries({ queryKey: ['bot', botId] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
    },
    onError: (err: Error) => toast.error(`Pause failed: ${err.message}`),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.closeBot(botId),
    onSuccess: () => {
      toast.success(`Bot ${botId} closed (orders cancelled, position closed)`);
      void queryClient.invalidateQueries({ queryKey: ['bot', botId] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
    },
    onError: (err: Error) => toast.error(`Close failed: ${err.message}`),
  });

  const confirm = useConfirm();

  // Dialog state for the "Update range" action. Declared up here so the
  // hook count is stable across early returns (Rules of Hooks).
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);

  // ── Now safe to early-return ──
  if (botQuery.isPending) return <PageSkeleton />;
  if (botQuery.isError) {
    return (
      <Card className="border-danger/40">
        <h2 className="text-lg font-semibold text-danger mb-2">
          Failed to load bot {botId}
        </h2>
        <p className="text-sm text-text-muted">
          {(botQuery.error as Error).message}
        </p>
      </Card>
    );
  }

  const bot = botQuery.data.bot;
  const status = tick?.status ?? bot.status;
  const positionSize = tick?.positionSize ?? bot.position_size;
  const avgEntry = tick?.avgEntryPrice ?? bot.avg_entry_price;
  const totalPnl = tick?.totalPnl ?? bot.total_pnl_usdt;
  const gridProfit = tick?.gridProfit ?? bot.grid_profit_usdt;
  const trendPnl = tick?.trendPnl ?? bot.trend_pnl_usdt;
  const equity = bot.investment_usdt + totalPnl;
  const equityPct = (totalPnl / bot.investment_usdt) * 100;

  // useMarkPrice is a plain helper despite the `use*` name — no hooks
  // inside it. Safe to call after the early return.
  const markPrice = useMarkPrice(gridStateQuery.data);
  const candles = candlesQuery.data?.candles ?? [];
  const levels: GridLevel[] = gridStateQuery.data?.levels ?? [];

  async function handleStart() {
    const ok = await confirm({
      variant: 'warning',
      title: `Start bot ${botId}?`,
      description: 'This will place real orders on GRVT.',
      body: (
        <div className="space-y-2">
          <p>The bot will immediately place limit orders on GRVT using:</p>
          <ul className="list-disc list-inside space-y-0.5 font-mono text-2xs">
            <li>
              Pair: <span className="text-text-primary">{bot.pair}</span>
            </li>
            <li>
              Direction:{' '}
              <span
                className={
                  bot.direction === 'long' ? 'text-success' : 'text-danger'
                }
              >
                {bot.direction.toUpperCase()}
              </span>
            </li>
            <li>
              Leverage:{' '}
              <span className="text-text-primary">{bot.leverage}x</span>
            </li>
            <li>
              Investment:{' '}
              <span className="text-text-primary">
                {formatUsd(bot.investment_usdt)}
              </span>
            </li>
            <li>
              Range:{' '}
              <span className="text-text-primary">
                {formatUsd(bot.lower_price)} — {formatUsd(bot.upper_price)}
              </span>
            </li>
            <li>
              Grid: <span className="text-text-primary">{bot.num_grids}</span>{' '}
              levels
            </li>
          </ul>
        </div>
      ),
      confirmLabel: 'Start trading',
      cancelLabel: 'Cancel',
    });
    if (ok) startMutation.mutate();
  }

  async function handlePause() {
    const openOrderCount = gridStateQuery.data?.openOrders.length ?? 0;
    const ok = await confirm({
      variant: 'destructive',
      title: `Pause bot ${botId}?`,
      description: `${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`,
      body: (
        <div className="space-y-2">
          <p className="font-semibold text-text-primary">
            This will <Mono>CANCEL {openOrderCount || 'ALL'}</Mono> open orders
            on GRVT.
          </p>
          <p>
            The position ({formatSize(positionSize)} ETH @{' '}
            <Mono>{formatUsd(avgEntry)}</Mono>) will{' '}
            <strong className="text-text-primary">not</strong> be closed —
            only the limit orders are cancelled. You can resume the bot later
            with <strong className="text-text-primary">Start</strong>, which
            will rebind to whatever orders or position is left.
          </p>
        </div>
      ),
      confirmLabel: `Cancel ${openOrderCount || 'all'} orders`,
      cancelLabel: 'Keep running',
    });
    if (ok) pauseMutation.mutate();
  }

  async function handleClose() {
    const openOrderCount = gridStateQuery.data?.openOrders.length ?? 0;
    const hasPosition = Math.abs(positionSize) > 1e-6;
    const ok = await confirm({
      variant: 'destructive',
      title: `Close bot ${botId}?`,
      description: `${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`,
      body: (
        <div className="space-y-2">
          <p className="font-semibold text-text-primary">
            This is final. The bot will be marked{' '}
            <Mono className="text-danger">stopped</Mono> and removed from the
            active list.
          </p>
          <p>The engine will:</p>
          <ul className="list-disc list-inside space-y-0.5 text-2xs">
            <li>
              Cancel <Mono>{openOrderCount || 'ALL'}</Mono> open orders on GRVT
            </li>
            {hasPosition ? (
              <li>
                Market-close <Mono>{formatSize(Math.abs(positionSize))}</Mono>{' '}
                ETH at ~0.5% aggressive limit (GTC) — small slippage cost
              </li>
            ) : (
              <li>No position to close (size = 0)</li>
            )}
            <li>Flip status to stopped (history is preserved)</li>
          </ul>
          <p className="text-2xs text-text-muted">
            Use <strong className="text-text-primary">Pause</strong> instead if
            you want to keep the position open and resume later.
          </p>
        </div>
      ),
      confirmLabel: hasPosition ? 'Cancel orders + close position' : 'Cancel all orders',
      cancelLabel: 'Keep bot',
    });
    if (ok) closeMutation.mutate();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            Bot {bot.id}
          </h1>
          <StatusPill status={status} />
          <span className="text-sm text-text-muted">
            {bot.pair} · {bot.direction.toUpperCase()} · {bot.leverage}x
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setRangeDialogOpen(true)}
            title="Move/expand the grid range — useful when price drifts out of grid"
          >
            <SlidersHorizontal className="size-4" />
            Update range
          </Button>
          {status === 'running' ? (
            <Button
              variant="secondary"
              onClick={handlePause}
              disabled={pauseMutation.isPending}
            >
              <Pause className="size-4" />
              {pauseMutation.isPending ? 'Pausing…' : 'Pause'}
            </Button>
          ) : status === 'paused' ? (
            <Button
              variant="primary"
              onClick={handleStart}
              disabled={startMutation.isPending}
            >
              <Play className="size-4" />
              {startMutation.isPending ? 'Starting…' : 'Start'}
            </Button>
          ) : null}
          {status !== 'stopped' && (
            <Button
              variant="danger"
              onClick={handleClose}
              disabled={closeMutation.isPending}
              title="Cancel all orders and close the position — final stop"
            >
              <XCircle className="size-4" />
              {closeMutation.isPending ? 'Closing…' : 'Close bot'}
            </Button>
          )}
        </div>
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border-subtle rounded-lg overflow-hidden">
        <StatCard
          label="Equity"
          value={formatUsd(equity)}
          delta={<Delta value={equityPct} format={formatPercent} />}
        />
        <StatCard
          label="Total PnL"
          value={
            <span
              className={
                totalPnl > 0
                  ? 'text-success'
                  : totalPnl < 0
                    ? 'text-danger'
                    : 'text-text-primary'
              }
            >
              {formatPnl(totalPnl)}
            </span>
          }
        />
        <StatCard label="Realized" value={formatPnl(gridProfit)} />
        <StatCard
          label="Unrealized"
          value={
            <span
              className={
                trendPnl > 0
                  ? 'text-success'
                  : trendPnl < 0
                    ? 'text-danger'
                    : 'text-text-primary'
              }
            >
              {formatPnl(trendPnl)}
            </span>
          }
        />
        <StatCard
          label="Position"
          value={`${formatSize(positionSize)}`}
          delta={
            <span className="text-xs text-text-muted">
              @ <Mono>{formatUsd(avgEntry)}</Mono>
            </span>
          }
        />
        <StatCard
          label="Liquidation"
          value={
            bot.liquidation_price != null && bot.liquidation_price > 0
              ? formatUsd(bot.liquidation_price)
              : '—'
          }
        />
      </div>

      {/* GridChart hero */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              Grid Chart
            </h2>
            <p className="text-2xs uppercase tracking-wider text-text-muted mt-0.5">
              {bot.pair} · 1H · {levels.length} levels
            </p>
          </div>
          <ChartLegend />
        </div>
        <div className="h-[480px] md:h-[560px]">
          {candlesQuery.isPending ? (
            <ChartSkeleton message="Loading candles…" />
          ) : candlesQuery.isError ? (
            <ChartSkeleton
              message={`Failed to load candles: ${(candlesQuery.error as Error).message}`}
              error
            />
          ) : (
            <GridChart
              candles={candles}
              levels={levels}
              markPrice={markPrice}
              entryPrice={avgEntry}
              liquidationPrice={bot.liquidation_price}
              recentlyFilled={recentlyFilled}
            />
          )}
        </div>
      </Card>

      {/* Equity curve + stats panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">
            Equity curve
          </h3>
          <BotDetailEquityCurve botId={botId} />
        </Card>
        <StatsPanel bot={bot} />
      </div>

      {/* Compound settings */}
      {status !== 'stopped' && (
        <CompoundSettings bot={bot} />
      )}

      {/* Tabs */}
      <BotDetailTabs botId={botId} />

      {/* Update grid range — operator escape hatch when price drifts
          out of the current range. Mounted at the page root so it can
          live-update from the same gridStateQuery the chart uses. */}
      <UpdateRangeDialog
        open={rangeDialogOpen}
        onClose={() => setRangeDialogOpen(false)}
        bot={bot}
        markPrice={markPrice}
      />
    </div>
  );
}

// ── Compound Reinvestment Settings ──────────────────────────────────────

function CompoundSettings({ bot }: { bot: any }) {
  const qc = useQueryClient();
  const [pct, setPct] = useState<number>(bot.compound_pct ?? 0);
  const [threshold, setThreshold] = useState<number>(bot.compound_threshold_usdt ?? 50);
  const [interval, setInterval_] = useState<number>(bot.compound_interval_hours ?? 24);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const dirty =
    pct !== (bot.compound_pct ?? 0) ||
    threshold !== (bot.compound_threshold_usdt ?? 50) ||
    interval !== (bot.compound_interval_hours ?? 24);

  const mutation = useMutation({
    mutationFn: () =>
      api.updateCompound(bot.id, {
        compound_pct: pct,
        compound_threshold_usdt: threshold,
        compound_interval_hours: interval,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot', bot.id] });
      qc.invalidateQueries({ queryKey: ['bots'] });
      toast.success(
        pct > 0
          ? `Compound set to ${pct}% every ${interval}h`
          : 'Compound disabled'
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const presets = [0, 10, 25, 50, 75, 100];
  const reinvested = bot.total_reinvested ?? 0;
  const lastAt = bot.last_compound_at;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Reinvestment
          </h3>
          <p className="text-2xs text-text-muted mt-0.5">
            Auto-reinvest grid profit into larger orders
          </p>
        </div>
        {reinvested > 0 && (
          <div className="text-right">
            <div className="text-2xs text-text-muted">Total reinvested</div>
            <Mono className="text-sm text-success">
              {formatUsd(reinvested)}
            </Mono>
          </div>
        )}
      </div>

      {/* Preset buttons */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-2xs text-text-muted w-20 shrink-0">
          Reinvest %
        </span>
        <div className="flex gap-1.5 flex-wrap">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPct(p)}
              className={`px-3 py-1 rounded text-xs font-mono tabular-nums transition-colors ${
                pct === p
                  ? 'bg-primary text-white'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-muted'
              }`}
            >
              {p}%
            </button>
          ))}
        </div>
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
          className="w-16 px-2 py-1 rounded bg-bg-elevated border border-border-subtle text-xs font-mono tabular-nums text-text-primary text-right"
          aria-label="Custom compound percentage"
        />
      </div>

      {/* Advanced settings toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-2xs text-text-muted hover:text-text-secondary mb-2"
      >
        {showAdvanced ? '- Hide' : '+ Show'} advanced
      </button>

      {showAdvanced && (
        <div className="flex gap-4 mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">
              Min profit (USD)
            </span>
            <input
              type="number"
              min={1}
              step={10}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 50))}
              className="w-24 px-2 py-1 rounded bg-bg-elevated border border-border-subtle text-xs font-mono tabular-nums text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">
              Check every (hours)
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={interval}
              onChange={(e) => setInterval_(Math.max(1, Number(e.target.value) || 24))}
              className="w-24 px-2 py-1 rounded bg-bg-elevated border border-border-subtle text-xs font-mono tabular-nums text-text-primary"
            />
          </label>
        </div>
      )}

      {/* Save + status */}
      <div className="flex items-center gap-3">
        <Button
          variant={dirty ? 'primary' : 'secondary'}
          onClick={() => mutation.mutate()}
          disabled={!dirty || mutation.isPending}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        {lastAt && (
          <span className="text-2xs text-text-muted">
            Last compound: {formatTimeUtc(lastAt)}
          </span>
        )}
        {pct === 0 && !dirty && (
          <span className="text-2xs text-text-muted">Disabled</span>
        )}
      </div>
    </Card>
  );
}

// ── Tabs (Fills + Snapshots for B.5; Orders/Funding deferred) ─────────

type DetailTab = 'roundtrips' | 'fills' | 'orders' | 'funding' | 'snapshots';

function BotDetailTabs({ botId }: { botId: number }) {
  const [tab, setTab] = useState<DetailTab>('roundtrips');

  // Fills come from fills_archive (populated by the engine's
  // pollFillArchive loop). Replaces the old getTrades query which
  // read from a table that had been frozen since 2026-03-10. Every
  // row in this query is a real GRVT fill with the real fee GRVT
  // charged or refunded for that account.
  const fillsQuery = useQuery({
    queryKey: ['fills', botId],
    queryFn: () => api.getFills(botId, { limit: 200 }),
    refetchInterval: 30_000, // matches the engine's poll cadence
  });

  const ordersQuery = useQuery({
    queryKey: ['orders', botId],
    queryFn: () => api.getOrders(botId, { status: 'all', limit: 200 }),
    refetchInterval: 15_000,
  });

  const fundingQuery = useQuery({
    queryKey: ['funding', botId],
    queryFn: () => api.getFunding(botId, { limit: 500 }),
    staleTime: 60_000,
  });

  const roundtripsQuery = useQuery({
    queryKey: ['roundtrips', botId],
    queryFn: () => api.getRoundtrips(botId),
    refetchInterval: 30_000,
  });

  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', botId],
    queryFn: () => api.getSnapshots(botId),
    staleTime: 5 * 60_000,
  });

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 pt-3">
        <Tabs
          items={[
            {
              value: 'roundtrips',
              label: 'Roundtrips',
              badge: roundtripsQuery.data?.count ?? '—',
            },
            {
              value: 'fills',
              label: 'Fills',
              badge: fillsQuery.data?.fills.length ?? '—',
            },
            {
              value: 'orders',
              label: 'Orders',
              badge: ordersQuery.data?.orders.length ?? '—',
            },
            {
              value: 'funding',
              label: 'Funding',
              badge: fundingQuery.data?.count ?? '—',
            },
            {
              value: 'snapshots',
              label: 'Snapshots',
              badge: snapshotsQuery.data?.snapshots.length ?? '—',
            },
          ]}
          value={tab}
          onChange={(v) => setTab(v as DetailTab)}
        >
          {tab === 'roundtrips' && (
            <RoundtripsTable
              roundtrips={roundtripsQuery.data?.roundtrips ?? []}
              totalProfit={roundtripsQuery.data?.totalProfit ?? 0}
              loading={roundtripsQuery.isPending}
            />
          )}
          {tab === 'fills' && (
            <FillsTable fills={fillsQuery.data?.fills ?? []} loading={fillsQuery.isPending} />
          )}
          {tab === 'orders' && (
            <OrdersTable
              orders={ordersQuery.data?.orders ?? []}
              degraded={ordersQuery.data?.degraded}
              hint={ordersQuery.data?.hint}
              loading={ordersQuery.isPending}
            />
          )}
          {tab === 'funding' && (
            <FundingTable
              funding={fundingQuery.data?.funding ?? []}
              total={fundingQuery.data?.totalPaymentUsdt ?? 0}
              loading={fundingQuery.isPending}
            />
          )}
          {tab === 'snapshots' && (
            <SnapshotsTable
              snapshots={snapshotsQuery.data?.snapshots ?? []}
              loading={snapshotsQuery.isPending}
            />
          )}
        </Tabs>
      </div>
    </Card>
  );
}

// ── Roundtrips Table ──────────────────────────────────────────────────

const ROUNDTRIP_COLUMNS: Column<Roundtrip>[] = [
  {
    key: 'time',
    header: 'Time (UTC)',
    render: (r) => formatTimeUtc(new Date(r.created_at).getTime()),
    sortValue: (r) => new Date(r.created_at).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'buy_price',
    header: 'Buy',
    render: (r) => formatUsd(r.buy_price),
    sortValue: (r) => r.buy_price,
    align: 'right',
    mono: true,
  },
  {
    key: 'sell_price',
    header: 'Sell',
    render: (r) => formatUsd(r.sell_price),
    sortValue: (r) => r.sell_price,
    align: 'right',
    mono: true,
  },
  {
    key: 'spread',
    header: 'Spread',
    render: (r) => {
      const spread = r.sell_price - r.buy_price;
      return (
        <span className="text-text-secondary">{formatUsd(spread)}</span>
      );
    },
    sortValue: (r) => r.sell_price - r.buy_price,
    align: 'right',
    mono: true,
  },
  {
    key: 'size',
    header: 'Size',
    render: (r) => formatSize(r.size),
    sortValue: (r) => r.size,
    align: 'right',
    mono: true,
  },
  {
    key: 'profit',
    header: 'Profit',
    render: (r) => (
      <span className={r.profit > 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>
        {formatPnl(r.profit)}
      </span>
    ),
    sortValue: (r) => r.profit,
    align: 'right',
    mono: true,
  },
];

function RoundtripsTable({
  roundtrips,
  totalProfit,
  loading,
}: {
  roundtrips: Roundtrip[];
  totalProfit: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading roundtrips…
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs gap-4">
        <span className="text-text-muted">
          <Mono>{roundtrips.length}</Mono> paired roundtrips
        </span>
        <span className="text-text-muted uppercase tracking-wider">
          Total profit:
        </span>
        <span className={totalProfit > 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>
          <Mono>{formatPnl(totalProfit)}</Mono>
        </span>
      </div>
      <DataTable
        columns={ROUNDTRIP_COLUMNS}
        rows={roundtrips}
        rowKey={(r) => r.id}
        pageSize={20}
      />
    </div>
  );
}

// Fee column rendering rule:
//   fee < 0  → user EARNED a maker rebate, show in green with "+" sign
//              (the negative sign on the wire = positive PnL for the user)
//   fee > 0  → user PAID a taker fee, show in red with "-" sign
//   fee == 0 → no charge, show muted "—"
// Per-fill rebates are tiny (~$0.001), so formatPnl's 2-decimal scale would
// collapse every row to "+$0.00". Use 4 decimals here so the user can see
// the actual rebate per fill — and tooltip the 6-decimal exact value for
// power-users / accounting reconciliation.
function formatFee4(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(4)}`;
}

function renderFee(fee: number): React.ReactNode {
  if (fee === 0) return <span className="text-text-disabled">—</span>;
  // Negative fee = rebate earned. Display as a positive PnL.
  const earned = -fee;
  return (
    <span
      className={earned > 0 ? 'text-success' : 'text-danger'}
      title={
        (earned > 0 ? 'Maker rebate earned: ' : 'Taker fee paid: ') +
        `$${earned.toFixed(6)}`
      }
    >
      {formatFee4(earned)}
    </span>
  );
}

const FILLS_COLUMNS: Column<FillRow>[] = [
  {
    key: 'time',
    header: 'Time (UTC)',
    render: (r) => formatTimeUtc(new Date(r.created_at).getTime()),
    sortValue: (r) => new Date(r.created_at).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'side',
    header: 'Side',
    render: (r) => (
      <span
        className={
          r.is_buyer === 1
            ? 'text-success font-semibold uppercase'
            : 'text-danger font-semibold uppercase'
        }
      >
        {r.is_buyer === 1 ? 'BUY' : 'SELL'}
      </span>
    ),
    align: 'center',
    width: '80px',
  },
  {
    key: 'price',
    header: 'Price',
    render: (r) => formatUsd(r.price),
    sortValue: (r) => r.price,
    align: 'right',
    mono: true,
  },
  {
    key: 'size',
    header: 'Size',
    render: (r) => formatSize(r.size),
    sortValue: (r) => r.size,
    align: 'right',
    mono: true,
  },
  {
    key: 'notional',
    header: 'Notional',
    render: (r) => formatUsd(r.price * r.size),
    sortValue: (r) => r.price * r.size,
    align: 'right',
    mono: true,
  },
  {
    key: 'fee',
    header: 'Fee / Rebate',
    render: (r) => renderFee(r.fee),
    sortValue: (r) => r.fee,
    align: 'right',
    mono: true,
  },
];

function FillsTable({ fills, loading }: { fills: FillRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading fills…
      </div>
    );
  }
  // Sum of (-fee) so positive = net rebate earned, negative = net fees paid.
  // ALL real GRVT data — sums whatever GRVT actually charged this account.
  const netRebate = fills.reduce((acc, f) => acc + -f.fee, 0);
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs gap-4">
        <span className="text-text-muted">
          Showing last <Mono>{fills.length}</Mono> fills
        </span>
        <span className="text-text-muted uppercase tracking-wider">
          Net rebate this window:
        </span>
        <span
          className={
            netRebate > 0
              ? 'text-success'
              : netRebate < 0
                ? 'text-danger'
                : 'text-text-primary'
          }
        >
          <Mono>{formatFee4(netRebate)}</Mono>
        </span>
      </div>
      <DataTable
        rows={fills}
        columns={FILLS_COLUMNS}
        pageSize={20}
        rowKey={(r) => r.id}
        emptyMessage="No fills yet (the engine polls fills every 30s)"
      />
    </div>
  );
}

const SNAPSHOT_COLUMNS: Column<DailySnapshot>[] = [
  {
    key: 'date',
    header: 'Date',
    render: (r) => r.date,
    sortValue: (r) => r.date,
    mono: true,
    width: '140px',
  },
  {
    key: 'equity',
    header: 'Equity',
    render: (r) => formatUsd(r.equity_usdt),
    sortValue: (r) => r.equity_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'realized',
    header: 'Realized',
    render: (r) => formatPnl(r.realized_pnl_usdt),
    sortValue: (r) => r.realized_pnl_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'unrealized',
    header: 'Unrealized',
    render: (r) => (
      <span
        className={
          r.unrealized_pnl_usdt > 0
            ? 'text-success'
            : r.unrealized_pnl_usdt < 0
              ? 'text-danger'
              : ''
        }
      >
        {formatPnl(r.unrealized_pnl_usdt)}
      </span>
    ),
    sortValue: (r) => r.unrealized_pnl_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'rt',
    header: 'Round trips',
    render: (r) => String(r.num_round_trips),
    sortValue: (r) => r.num_round_trips,
    align: 'right',
    mono: true,
  },
  {
    key: 'fees',
    header: 'Fees',
    render: (r) => formatUsd(r.total_fees_usdt),
    sortValue: (r) => r.total_fees_usdt,
    align: 'right',
    mono: true,
  },
];

function SnapshotsTable({
  snapshots,
  loading,
}: {
  snapshots: DailySnapshot[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading snapshots…
      </div>
    );
  }
  return (
    <DataTable
      rows={snapshots}
      columns={SNAPSHOT_COLUMNS}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage="No snapshots yet"
    />
  );
}

// ── Orders ────────────────────────────────────────────────────────────

const ORDER_STATUS_TONE: Record<OrderRow['status'], string> = {
  pending: 'text-warning',
  filled: 'text-success',
  cancelled: 'text-text-muted',
  rejected: 'text-danger',
};

const ORDERS_COLUMNS: Column<OrderRow>[] = [
  {
    key: 'time',
    header: 'Updated',
    render: (r) => formatTimeUtc(new Date(r.updated_at).getTime()),
    sortValue: (r) => new Date(r.updated_at).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'side',
    header: 'Side',
    render: (r) => (
      <span
        className={
          r.side === 'buy'
            ? 'text-success font-semibold uppercase'
            : 'text-danger font-semibold uppercase'
        }
      >
        {r.side}
      </span>
    ),
    align: 'center',
    width: '70px',
  },
  {
    key: 'type',
    header: 'Type',
    render: (r) => (
      <span className="uppercase text-2xs tracking-wider">{r.type}</span>
    ),
    align: 'center',
    width: '70px',
  },
  {
    key: 'price',
    header: 'Price',
    render: (r) => formatUsd(r.price),
    sortValue: (r) => r.price,
    align: 'right',
    mono: true,
  },
  {
    key: 'qty',
    header: 'Size',
    render: (r) => formatSize(r.quantity),
    sortValue: (r) => r.quantity,
    align: 'right',
    mono: true,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className={`${ORDER_STATUS_TONE[r.status]} uppercase tracking-wider text-2xs font-semibold`}>
        {r.status}
      </span>
    ),
    align: 'center',
  },
  {
    key: 'order_id',
    header: 'Order ID',
    render: (r) => <span className="text-text-muted text-2xs">{r.order_id.slice(0, 12)}…</span>,
    align: 'left',
  },
];

function OrdersTable({
  orders,
  loading,
  degraded,
  hint,
}: {
  orders: OrderRow[];
  loading: boolean;
  degraded?: boolean;
  hint?: string;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading orders…
      </div>
    );
  }
  if (degraded) {
    return (
      <div className="text-center py-8 text-sm text-warning">
        Orders table degraded
        {hint && <div className="text-2xs text-text-muted mt-1">{hint}</div>}
      </div>
    );
  }
  return (
    <DataTable
      rows={orders}
      columns={ORDERS_COLUMNS}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage="No orders in local DB yet"
    />
  );
}

// ── Funding ───────────────────────────────────────────────────────────

const FUNDING_COLUMNS: Column<FundingRow>[] = [
  {
    key: 'time',
    header: 'Time (UTC)',
    render: (r) => {
      const ms = new Date(r.funding_time).getTime();
      return formatTimeUtc(ms);
    },
    sortValue: (r) => new Date(r.funding_time).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'rate',
    header: 'Rate',
    render: (r) => `${(r.funding_rate * 100).toFixed(4)}%`,
    sortValue: (r) => r.funding_rate,
    align: 'right',
    mono: true,
  },
  {
    key: 'pos',
    header: 'Position',
    render: (r) => formatSize(r.position_size),
    sortValue: (r) => r.position_size,
    align: 'right',
    mono: true,
  },
  {
    key: 'payment',
    header: 'Payment',
    render: (r) => (
      <span
        className={
          r.payment_usdt > 0
            ? 'text-success'
            : r.payment_usdt < 0
              ? 'text-danger'
              : ''
        }
      >
        {formatPnl(r.payment_usdt)}
      </span>
    ),
    sortValue: (r) => r.payment_usdt,
    align: 'right',
    mono: true,
  },
];

function FundingTable({
  funding,
  total,
  loading,
}: {
  funding: FundingRow[];
  total: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading funding…
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs">
        <span className="text-text-muted uppercase tracking-wider mr-2">
          Total
        </span>
        <span
          className={
            total > 0
              ? 'text-success'
              : total < 0
                ? 'text-danger'
                : 'text-text-primary'
          }
        >
          <Mono>{formatPnl(total)}</Mono>
        </span>
      </div>
      <DataTable
        rows={funding}
        columns={FUNDING_COLUMNS}
        pageSize={20}
        rowKey={(r) => r.id}
        emptyMessage="No funding events recorded"
      />
    </div>
  );
}

function BotDetailEquityCurve({ botId }: { botId: number }) {
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', botId],
    queryFn: () => api.getSnapshots(botId),
    staleTime: 5 * 60_000,
  });
  if (snapshotsQuery.isPending) {
    return (
      <div className="h-60 flex items-center justify-center text-sm text-text-muted animate-pulse">
        Loading…
      </div>
    );
  }
  return <EquityCurve snapshots={snapshotsQuery.data?.snapshots ?? []} />;
}

function ChartLegend() {
  return (
    <div className="hidden md:flex items-center gap-4 text-2xs">
      <LegendDot color="bg-success" label="BUY" />
      <LegendDot color="bg-danger" label="SELL" />
      <LegendDot color="bg-border-strong" label="FILLED" />
      <LegendDot color="bg-warning" label="PENDING" />
      <LegendDot color="bg-primary" label="MARK" />
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-text-muted uppercase tracking-wider">
      <span className={`inline-block h-0.5 w-3 ${color}`} />
      {label}
    </span>
  );
}

function ChartSkeleton({
  message,
  error,
}: {
  message: string;
  error?: boolean;
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <p
        className={
          error ? 'text-sm text-danger' : 'text-sm text-text-muted animate-pulse'
        }
      >
        {message}
      </p>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="h-8 w-48 bg-bg-elevated rounded" />
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border-subtle rounded-lg overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-24 bg-bg-elevated" />
        ))}
      </div>
      <div className="h-[480px] bg-bg-elevated rounded-lg" />
    </div>
  );
}

// Pull a numeric mark price out of the grid-state ticker payload.
// GRVT ticker shape varies; we look for the most likely fields.
function useMarkPrice(state: GridState | undefined): number | null {
  const ticker = state?.ticker as
    | { mark_price?: string | number; last_price?: string | number; price?: string | number }
    | undefined;
  if (!ticker) return null;
  const candidate = ticker.mark_price ?? ticker.last_price ?? ticker.price;
  if (candidate == null) return null;
  const num = typeof candidate === 'string' ? parseFloat(candidate) : candidate;
  return Number.isFinite(num) ? num : null;
}
