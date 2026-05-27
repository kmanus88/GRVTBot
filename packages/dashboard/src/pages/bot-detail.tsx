// Bot Detail page — GridChart hero + 6-card stat strip + secondary equity
// curve / stats panel + tabs for Fills/Snapshots.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Pause, Play, SlidersHorizontal, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { LiqGauge } from '@/components/charts/liq-gauge';
import { FillHeatmap } from '@/components/charts/fill-heatmap';
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
import { useT } from '@/i18n';

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
  const t = useT();
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

  // H.5: sub-account label resolution. We share the cache key with
  // Settings + the create-bot wizard so this is normally a cache hit.
  const subAccountsQuery = useQuery({
    queryKey: ['sub-accounts'],
    queryFn: () => api.listSubAccounts(),
    enabled: !!botQuery.data?.bot.grvt_sub_account_id,
    staleTime: 60_000,
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
  // E.3: optimistic UI updates — the bot status changes instantly in the
  // cache when the user confirms an action, then the server response
  // reconciles. On error we rollback to the previous state. This removes
  // the "click → wait 2-5s → see change" lag that made the UI feel broken.

  const optimisticBotUpdate = (newStatus: string) => ({
    async onMutate() {
      // Cancel in-flight refetches so they don't overwrite our optimistic value
      await queryClient.cancelQueries({ queryKey: ['bot', botId] });
      await queryClient.cancelQueries({ queryKey: ['bots'] });
      // Snapshot for rollback
      const prevBot = queryClient.getQueryData(['bot', botId]);
      const prevBots = queryClient.getQueryData(['bots']);
      // Optimistically update the single-bot cache
      queryClient.setQueryData(['bot', botId], (old: any) =>
        old ? { ...old, bot: { ...old.bot, status: newStatus } } : old
      );
      // Optimistically update the bots list cache
      queryClient.setQueryData(['bots'], (old: any) =>
        old
          ? {
              ...old,
              bots: old.bots.map((b: any) =>
                b.id === botId ? { ...b, status: newStatus } : b
              ),
            }
          : old
      );
      return { prevBot, prevBots };
    },
    onError(_err: Error, _vars: void, ctx: { prevBot?: unknown; prevBots?: unknown } | undefined) {
      // Rollback on failure
      if (ctx?.prevBot) queryClient.setQueryData(['bot', botId], ctx.prevBot);
      if (ctx?.prevBots) queryClient.setQueryData(['bots'], ctx.prevBots);
      toast.error(t('botDetail.actionFailed', { msg: _err.message }));
    },
    onSettled() {
      // Always refetch after settled to get the real server state
      void queryClient.invalidateQueries({ queryKey: ['bot', botId] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
    },
  });

  const startMutation = useMutation({
    mutationFn: () => api.startBot(botId),
    ...optimisticBotUpdate('running'),
    onSuccess: () => toast.success(t('botDetail.startedToast', { id: botId })),
  });

  const pauseMutation = useMutation({
    mutationFn: () => api.pauseBot(botId),
    ...optimisticBotUpdate('paused'),
    onSuccess: () => toast.success(t('botDetail.pausedToast', { id: botId })),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.closeBot(botId),
    ...optimisticBotUpdate('stopped'),
    onSuccess: () => toast.success(t('botDetail.closedToast', { id: botId })),
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
          {t('botDetail.failedToLoad', { id: botId })}
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
      title: t('botDetail.confirmStart.title', { id: botId }),
      description: t('botDetail.confirmStart.description'),
      body: (
        <div className="space-y-2">
          <p>{t('botDetail.confirmStart.lead')}</p>
          <ul className="list-disc list-inside space-y-0.5 font-mono text-2xs">
            <li>
              {t('botDetail.confirmStart.pair')}{' '}
              <span className="text-text-primary">{bot.pair}</span>
            </li>
            <li>
              {t('botDetail.confirmStart.direction')}{' '}
              <span
                className={
                  bot.direction === 'long' ? 'text-success' : 'text-danger'
                }
              >
                {bot.direction.toUpperCase()}
              </span>
            </li>
            <li>
              {t('botDetail.confirmStart.leverage')}{' '}
              <span className="text-text-primary">{bot.leverage}x</span>
            </li>
            <li>
              {t('botDetail.confirmStart.investment')}{' '}
              <span className="text-text-primary">
                {formatUsd(bot.investment_usdt)}
              </span>
            </li>
            <li>
              {t('botDetail.confirmStart.range')}{' '}
              <span className="text-text-primary">
                {formatUsd(bot.lower_price)} — {formatUsd(bot.upper_price)}
              </span>
            </li>
            <li>
              {t('botDetail.confirmStart.grid')} <span className="text-text-primary">{bot.num_grids}</span>{' '}
              {t('botDetail.confirmStart.levelsSuffix')}
            </li>
          </ul>
        </div>
      ),
      confirmLabel: t('botDetail.confirmStart.confirm'),
      cancelLabel: t('botDetail.confirmStart.cancel'),
    });
    if (ok) startMutation.mutate();
  }

  async function handlePause() {
    const openOrderCount = gridStateQuery.data?.openOrders.length ?? 0;
    const ok = await confirm({
      variant: 'destructive',
      title: t('botDetail.confirmPause.title', { id: botId }),
      description: `${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`,
      body: (
        <div className="space-y-2">
          <p className="font-semibold text-text-primary">
            {t('botDetail.confirmPause.leadOpen')}{' '}
            <Mono>
              {openOrderCount
                ? t('botDetail.confirmPause.leadCancel', { n: openOrderCount })
                : t('botDetail.confirmPause.leadCancelAll')}
            </Mono>{' '}
            {t('botDetail.confirmPause.leadEnd')}
          </p>
          <p>
            {t('botDetail.confirmPause.body', {
              size: formatSize(positionSize),
              price: formatUsd(avgEntry),
            })}
          </p>
        </div>
      ),
      confirmLabel: openOrderCount
        ? t('botDetail.confirmPause.confirmCount', { n: openOrderCount })
        : t('botDetail.confirmPause.confirmAll'),
      cancelLabel: t('botDetail.confirmPause.cancel'),
    });
    if (ok) pauseMutation.mutate();
  }

  async function handleClose() {
    const openOrderCount = gridStateQuery.data?.openOrders.length ?? 0;
    const hasPosition = Math.abs(positionSize) > 1e-6;
    const ok = await confirm({
      variant: 'destructive',
      title: t('botDetail.confirmClose.title', { id: botId }),
      description: `${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`,
      body: (
        <div className="space-y-2">
          <p className="font-semibold text-text-primary">
            {t('botDetail.confirmClose.finalLead')}{' '}
            <Mono className="text-danger">{t('botDetail.confirmClose.stopped')}</Mono>{' '}
            {t('botDetail.confirmClose.finalEnd')}
          </p>
          <p>{t('botDetail.confirmClose.engineWill')}</p>
          <ul className="list-disc list-inside space-y-0.5 text-2xs">
            <li>
              {openOrderCount
                ? t('botDetail.confirmClose.cancelOrders', { n: openOrderCount })
                : t('botDetail.confirmClose.cancelOrdersAll')}
            </li>
            {hasPosition ? (
              <li>
                {t('botDetail.confirmClose.marketClose', {
                  size: formatSize(Math.abs(positionSize)),
                })}
              </li>
            ) : (
              <li>{t('botDetail.confirmClose.noPosition')}</li>
            )}
            <li>{t('botDetail.confirmClose.flipStatus')}</li>
          </ul>
          <p className="text-2xs text-text-muted">
            {t('botDetail.confirmClose.pauseInstead')}
          </p>
        </div>
      ),
      confirmLabel: hasPosition
        ? t('botDetail.confirmClose.confirmWithPos')
        : t('botDetail.confirmClose.confirmNoPos'),
      cancelLabel: t('botDetail.confirmClose.cancel'),
    });
    if (ok) closeMutation.mutate();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('botDetail.pageHeading', { id: bot.id })}
          </h1>
          <StatusPill status={status} />
          <span className="text-sm text-text-muted">
            {bot.pair} · {bot.direction.toUpperCase()} · {bot.leverage}x
          </span>
          {bot.grvt_sub_account_id != null && (
            <span className="text-2xs uppercase tracking-wider text-primary border border-primary/40 rounded-md px-2 py-0.5">
              {subAccountsQuery.data?.find(
                (s) => s.id === bot.grvt_sub_account_id
              )?.label ?? t('botDetail.subAccountFallback', { id: bot.grvt_sub_account_id })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setRangeDialogOpen(true)}
            title={t('botDetail.updateRangeHint')}
          >
            <SlidersHorizontal className="size-4" />
            {t('botDetail.updateRange')}
          </Button>
          {status === 'running' ? (
            <Button
              variant="secondary"
              onClick={handlePause}
              disabled={pauseMutation.isPending}
            >
              <Pause className="size-4" />
              {pauseMutation.isPending
                ? t('botDetail.pausing')
                : t('botDetail.pause')}
            </Button>
          ) : status === 'paused' ? (
            <Button
              variant="primary"
              onClick={handleStart}
              disabled={startMutation.isPending}
            >
              <Play className="size-4" />
              {startMutation.isPending
                ? t('botDetail.starting')
                : t('botDetail.start')}
            </Button>
          ) : null}
          {status !== 'stopped' && (
            <Button
              variant="danger"
              onClick={handleClose}
              disabled={closeMutation.isPending}
              title={t('botDetail.closeBotHint')}
            >
              <XCircle className="size-4" />
              {closeMutation.isPending
                ? t('botDetail.closing')
                : t('botDetail.closeBot')}
            </Button>
          )}
        </div>
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border-subtle rounded-lg overflow-hidden">
        <StatCard
          label={t('botDetail.stat.equity')}
          value={formatUsd(equity)}
          delta={<Delta value={equityPct} format={formatPercent} />}
        />
        <StatCard
          label={t('botDetail.stat.totalPnl')}
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
        <StatCard label={t('botDetail.stat.realized')} value={formatPnl(gridProfit)} />
        <StatCard
          label={t('botDetail.stat.unrealized')}
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
          label={t('botDetail.stat.position')}
          value={`${formatSize(positionSize)}`}
          delta={
            <span className="text-xs text-text-muted">
              @ <Mono>{formatUsd(avgEntry)}</Mono>
            </span>
          }
        />
        <StatCard
          label={t('botDetail.stat.liquidation')}
          value={
            bot.liquidation_price != null && bot.liquidation_price > 0
              ? formatUsd(bot.liquidation_price)
              : '—'
          }
        />
      </div>

      {/* E.1: Liquidation distance gauge */}
      {bot.liquidation_price != null && bot.liquidation_price > 0 && markPrice != null && (
        <LiqGauge
          markPrice={markPrice}
          liqPrice={bot.liquidation_price}
          direction={bot.direction}
        />
      )}

      {/* GridChart hero */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {t('botDetail.gridChart')}
            </h2>
            <p className="text-2xs uppercase tracking-wider text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{bot.pair} · 1H · {t('botDetail.chart.levels', { n: levels.length })}</span>
              {(() => {
                const active = levels.filter((l) => l.is_filled === 0 && l.state !== 'virtual').length;
                const virtual = levels.filter((l) => l.state === 'virtual').length;
                const filled = levels.filter((l) => l.is_filled === 1).length;
                return (
                  <span className="flex items-center gap-1.5 normal-case tracking-normal">
                    <span className="text-emerald-400">{t('botDetail.chart.active', { n: active })}</span>
                    {virtual > 0 && (
                      <>
                        <span className="text-text-muted">·</span>
                        <span className="text-slate-500">{t('botDetail.chart.virtual', { n: virtual })}</span>
                      </>
                    )}
                    <span className="text-text-muted">·</span>
                    <span className="text-text-muted">{t('botDetail.chart.filled', { n: filled })}</span>
                  </span>
                );
              })()}
            </p>
          </div>
          <ChartLegend />
        </div>
        <div className="h-[320px] sm:h-[420px] md:h-[560px]">
          {candlesQuery.isPending ? (
            <ChartSkeleton message={t('botDetail.chart.loadingCandles')} />
          ) : candlesQuery.isError ? (
            <ChartSkeleton
              message={t('botDetail.chart.failedCandles', { msg: (candlesQuery.error as Error).message })}
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
            {t('botDetail.equityCurve')}
          </h3>
          <BotDetailEquityCurve botId={botId} />
        </Card>
        <StatsPanel bot={bot} />
      </div>

      {/* E.6: Fill activity heatmap */}
      {gridStateQuery.data?.levels && gridStateQuery.data.levels.length > 0 && (
        <Card className="p-5">
          <FillHeatmapSection
            botId={botId}
            levels={gridStateQuery.data.levels}
            spacing={
              gridStateQuery.data.levels.length > 1
                ? Math.abs(gridStateQuery.data.levels[1]!.price - gridStateQuery.data.levels[0]!.price)
                : 1
            }
          />
        </Card>
      )}

      {/* Compound settings */}
      {status !== 'stopped' && (
        <CompoundSettings bot={bot} />
      )}

      {/* H.3 — Stop-loss / take-profit. Editable in-place — clearing the
          field disables it. Hidden for stopped bots since the engine is
          no longer monitoring. */}
      {status !== 'stopped' && (
        <RiskSettings bot={bot} />
      )}

      {/* H.2 — auto-shift status. Only shown when the bot was configured
          with auto_shift_enabled at creation. Read-only view. */}
      {bot.auto_shift_enabled === 1 && (
        <AutoShiftStatus bot={bot} />
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

// ── H.3: Stop-loss / Take-profit settings (editable in place).
// Both are percentages of investment_usdt. Empty input disables the
// guard. The engine refreshes the bot row at the top of every monitor
// tick so changes take effect within ~5s.

function RiskSettings({ bot }: { bot: any }) {
  const t = useT();
  const qc = useQueryClient();
  const [sl, setSl] = useState<string>(
    bot.sl_pct != null ? String(bot.sl_pct) : ''
  );
  const [tp, setTp] = useState<string>(
    bot.tp_pct != null ? String(bot.tp_pct) : ''
  );

  const slNum = sl === '' ? null : parseFloat(sl);
  const tpNum = tp === '' ? null : parseFloat(tp);

  const slInvalid =
    sl !== '' && (Number.isNaN(slNum!) || slNum! <= 0 || slNum! > 100);
  const tpInvalid =
    tp !== '' && (Number.isNaN(tpNum!) || tpNum! <= 0 || tpNum! > 1000);

  const dirty =
    (bot.sl_pct ?? null) !== slNum || (bot.tp_pct ?? null) !== tpNum;

  const mut = useMutation({
    mutationFn: () => api.updateRisk(bot.id, { sl_pct: slNum, tp_pct: tpNum }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bots'] });
      qc.invalidateQueries({ queryKey: ['bot', bot.id] });
      toast.success(
        slNum == null && tpNum == null
          ? t('botDetail.risk.disabledToast')
          : t('botDetail.risk.updatedToast')
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t('botDetail.stopLossTakeProfit')}
          </h3>
          <p className="text-2xs text-text-muted mt-0.5">
            {t('botDetail.risk.helper')}
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!dirty || slInvalid || tpInvalid || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? t('botDetail.risk.saving') : t('botDetail.risk.save')}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-2xs text-text-muted block mb-1">
            {t('botDetail.risk.slLabel')}
          </label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            placeholder={t('botDetail.risk.off')}
            value={sl}
            onChange={(e) => setSl(e.target.value)}
            className={`w-full bg-bg-base border rounded-md px-3 py-2 text-sm font-mono text-text-primary outline-none focus:ring-2 focus:ring-primary/50 ${
              slInvalid ? 'border-danger' : 'border-border-default'
            }`}
          />
        </div>
        <div>
          <label className="text-2xs text-text-muted block mb-1">
            {t('botDetail.risk.tpLabel')}
          </label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="1000"
            step="0.1"
            placeholder={t('botDetail.risk.off')}
            value={tp}
            onChange={(e) => setTp(e.target.value)}
            className={`w-full bg-bg-base border rounded-md px-3 py-2 text-sm font-mono text-text-primary outline-none focus:ring-2 focus:ring-primary/50 ${
              tpInvalid ? 'border-danger' : 'border-border-default'
            }`}
          />
        </div>
      </div>
    </Card>
  );
}

// ── H.2: Auto-shift status (read-only). Auto-shift is configured at
// creation time and currently has no in-place edit UI — when triggered,
// the engine re-centers the range on current price and writes
// last_auto_shift_at. Cooldown is 1h between shifts.

function AutoShiftStatus({ bot }: { bot: any }) {
  const t = useT();
  const triggerPct = bot.auto_shift_pct ?? 0;
  const lastAt = bot.last_auto_shift_at as number | null | undefined;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t('botDetail.autoShift.title')}
          </h3>
          <p className="text-2xs text-text-muted mt-0.5">
            {t('botDetail.autoShift.helper', { pct: triggerPct })}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xs text-text-muted">{t('botDetail.autoShift.lastShift')}</div>
          <Mono className="text-sm text-text-primary">
            {formatTimeUtc(lastAt ?? null)}
          </Mono>
        </div>
      </div>
    </Card>
  );
}

// ── Compound Reinvestment Settings ──────────────────────────────────────

function CompoundSettings({ bot }: { bot: any }) {
  const t = useT();
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
          ? t('botDetail.compound.enabledToast', { pct, h: interval })
          : t('botDetail.compound.disabledToast')
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
            {t('botDetail.compound.title')}
          </h3>
          <p className="text-2xs text-text-muted mt-0.5">
            {t('botDetail.compound.helper')}
          </p>
        </div>
        {reinvested > 0 && (
          <div className="text-right">
            <div className="text-2xs text-text-muted">{t('botDetail.compound.totalReinvested')}</div>
            <Mono className="text-sm text-success">
              {formatUsd(reinvested)}
            </Mono>
          </div>
        )}
      </div>

      {/* Preset buttons */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-2xs text-text-muted w-20 shrink-0">
          {t('botDetail.compound.reinvestLabel')}
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
        {showAdvanced ? t('botDetail.compound.hideAdvanced') : t('botDetail.compound.showAdvanced')}
      </button>

      {showAdvanced && (
        <div className="flex gap-4 mb-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">
              {t('botDetail.compound.minProfit')}
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
              {t('botDetail.compound.checkEvery')}
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
          {mutation.isPending ? t('botDetail.compound.saving') : t('botDetail.compound.save')}
        </Button>
        {lastAt && (
          <span className="text-2xs text-text-muted">
            {t('botDetail.compound.lastCompound', { time: formatTimeUtc(lastAt) })}
          </span>
        )}
        {pct === 0 && !dirty && (
          <span className="text-2xs text-text-muted">{t('botDetail.compound.disabledLabel')}</span>
        )}
      </div>
    </Card>
  );
}

// ── Tabs (Fills + Snapshots for B.5; Orders/Funding deferred) ─────────

type DetailTab = 'roundtrips' | 'fills' | 'orders' | 'funding' | 'snapshots';

function BotDetailTabs({ botId }: { botId: number }) {
  const t = useT();
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
              label: t('botDetail.tabs.roundtrips'),
              badge: roundtripsQuery.data?.count ?? '—',
            },
            {
              value: 'fills',
              label: t('botDetail.tabs.fills'),
              badge: fillsQuery.data?.fills.length ?? '—',
            },
            {
              value: 'orders',
              label: t('botDetail.tabs.orders'),
              badge: ordersQuery.data?.orders.length ?? '—',
            },
            {
              value: 'funding',
              label: t('botDetail.tabs.funding'),
              badge: fundingQuery.data?.count ?? '—',
            },
            {
              value: 'snapshots',
              label: t('botDetail.tabs.snapshots'),
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

function useRoundtripColumns(): Column<Roundtrip>[] {
  const t = useT();
  return [
    {
      key: 'time',
      header: t('botDetail.tables.colTime'),
      render: (r) => formatTimeUtc(new Date(r.created_at).getTime()),
      sortValue: (r) => new Date(r.created_at).getTime(),
      mono: true,
      width: '160px',
    },
    {
      key: 'buy_price',
      header: t('botDetail.tables.colBuy'),
      render: (r) => formatUsd(r.buy_price),
      sortValue: (r) => r.buy_price,
      align: 'right',
      mono: true,
    },
    {
      key: 'sell_price',
      header: t('botDetail.tables.colSell'),
      render: (r) => formatUsd(r.sell_price),
      sortValue: (r) => r.sell_price,
      align: 'right',
      mono: true,
    },
    {
      key: 'spread',
      header: t('botDetail.tables.colSpread'),
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
      header: t('botDetail.tables.colSize'),
      render: (r) => formatSize(r.size),
      sortValue: (r) => r.size,
      align: 'right',
      mono: true,
    },
    {
      key: 'profit',
      header: t('botDetail.tables.colProfit'),
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
}

function RoundtripsTable({
  roundtrips,
  totalProfit,
  loading,
}: {
  roundtrips: Roundtrip[];
  totalProfit: number;
  loading: boolean;
}) {
  const t = useT();
  const columns = useRoundtripColumns();
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingRoundtrips')}
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs gap-4">
        <span className="text-text-muted">
          {t('botDetail.tables.pairedCount', { n: roundtrips.length })}
        </span>
        <span className="text-text-muted uppercase tracking-wider">
          {t('botDetail.tables.totalProfit')}
        </span>
        <span className={totalProfit > 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>
          <Mono>{formatPnl(totalProfit)}</Mono>
        </span>
      </div>
      <DataTable
        columns={columns}
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

function useRenderFee(): (fee: number) => React.ReactNode {
  const t = useT();
  return (fee: number) => {
    if (fee === 0) return <span className="text-text-disabled">—</span>;
    const earned = -fee;
    return (
      <span
        className={earned > 0 ? 'text-success' : 'text-danger'}
        title={
          (earned > 0
            ? t('botDetail.tables.rebateEarned')
            : t('botDetail.tables.feePaid')) +
          `$${earned.toFixed(6)}`
        }
      >
        {formatFee4(earned)}
      </span>
    );
  };
}

function useFillsColumns(): Column<FillRow>[] {
  const t = useT();
  const renderFee = useRenderFee();
  return [
    {
      key: 'time',
      header: t('botDetail.tables.colTime'),
      render: (r) => formatTimeUtc(new Date(r.created_at).getTime()),
      sortValue: (r) => new Date(r.created_at).getTime(),
      mono: true,
      width: '160px',
    },
    {
      key: 'side',
      header: t('botDetail.tables.colSide'),
      render: (r) => (
        <span
          className={
            r.is_buyer === 1
              ? 'text-success font-semibold uppercase'
              : 'text-danger font-semibold uppercase'
          }
        >
          {r.is_buyer === 1
            ? t('botDetail.tables.sideBuy')
            : t('botDetail.tables.sideSell')}
        </span>
      ),
      align: 'center',
      width: '80px',
    },
    {
      key: 'price',
      header: t('botDetail.tables.colPrice'),
      render: (r) => formatUsd(r.price),
      sortValue: (r) => r.price,
      align: 'right',
      mono: true,
    },
    {
      key: 'size',
      header: t('botDetail.tables.colSize'),
      render: (r) => formatSize(r.size),
      sortValue: (r) => r.size,
      align: 'right',
      mono: true,
    },
    {
      key: 'notional',
      header: t('botDetail.tables.colNotional'),
      render: (r) => formatUsd(r.price * r.size),
      sortValue: (r) => r.price * r.size,
      align: 'right',
      mono: true,
    },
    {
      key: 'fee',
      header: t('botDetail.tables.colFeeRebate'),
      render: (r) => renderFee(r.fee),
      sortValue: (r) => r.fee,
      align: 'right',
      mono: true,
    },
  ];
}

function FillsTable({ fills, loading }: { fills: FillRow[]; loading: boolean }) {
  const t = useT();
  const columns = useFillsColumns();
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingFills')}
      </div>
    );
  }
  const netRebate = fills.reduce((acc, f) => acc + -f.fee, 0);
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs gap-4">
        <span className="text-text-muted">
          {t('botDetail.tables.showingLast', { n: fills.length })}
        </span>
        <span className="text-text-muted uppercase tracking-wider">
          {t('botDetail.tables.netRebateWindow')}
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
        columns={columns}
        pageSize={20}
        rowKey={(r) => r.id}
        emptyMessage={t('botDetail.tables.emptyFills')}
      />
    </div>
  );
}

function useSnapshotColumns(): Column<DailySnapshot>[] {
  const t = useT();
  return [
    {
      key: 'date',
      header: t('botDetail.tables.colDate'),
      render: (r) => r.date,
      sortValue: (r) => r.date,
      mono: true,
      width: '140px',
    },
    {
      key: 'equity',
      header: t('botDetail.tables.colEquity'),
      render: (r) => formatUsd(r.equity_usdt),
      sortValue: (r) => r.equity_usdt,
      align: 'right',
      mono: true,
    },
    {
      key: 'realized',
      header: t('botDetail.tables.colRealized'),
      render: (r) => formatPnl(r.realized_pnl_usdt),
      sortValue: (r) => r.realized_pnl_usdt,
      align: 'right',
      mono: true,
    },
    {
      key: 'unrealized',
      header: t('botDetail.tables.colUnrealized'),
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
      header: t('botDetail.tables.colRoundTrips'),
      render: (r) => String(r.num_round_trips),
      sortValue: (r) => r.num_round_trips,
      align: 'right',
      mono: true,
    },
    {
      key: 'fees',
      header: t('botDetail.tables.colFees'),
      render: (r) => formatUsd(r.total_fees_usdt),
      sortValue: (r) => r.total_fees_usdt,
      align: 'right',
      mono: true,
    },
  ];
}

function SnapshotsTable({
  snapshots,
  loading,
}: {
  snapshots: DailySnapshot[];
  loading: boolean;
}) {
  const t = useT();
  const columns = useSnapshotColumns();
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingSnapshots')}
      </div>
    );
  }
  return (
    <DataTable
      rows={snapshots}
      columns={columns}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage={t('botDetail.tables.emptySnapshots')}
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

function useOrdersColumns(): Column<OrderRow>[] {
  const t = useT();
  return [
    {
      key: 'time',
      header: t('botDetail.tables.colUpdated'),
      render: (r) => formatTimeUtc(new Date(r.updated_at).getTime()),
      sortValue: (r) => new Date(r.updated_at).getTime(),
      mono: true,
      width: '160px',
    },
    {
      key: 'side',
      header: t('botDetail.tables.colSide'),
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
      header: t('botDetail.tables.colType'),
      render: (r) => (
        <span className="uppercase text-2xs tracking-wider">{r.type}</span>
      ),
      align: 'center',
      width: '70px',
    },
    {
      key: 'price',
      header: t('botDetail.tables.colPrice'),
      render: (r) => formatUsd(r.price),
      sortValue: (r) => r.price,
      align: 'right',
      mono: true,
    },
    {
      key: 'qty',
      header: t('botDetail.tables.colSize'),
      render: (r) => formatSize(r.quantity),
      sortValue: (r) => r.quantity,
      align: 'right',
      mono: true,
    },
    {
      key: 'status',
      header: t('botDetail.tables.colStatus'),
      render: (r) => (
        <span className={`${ORDER_STATUS_TONE[r.status]} uppercase tracking-wider text-2xs font-semibold`}>
          {r.status}
        </span>
      ),
      align: 'center',
    },
    {
      key: 'order_id',
      header: t('botDetail.tables.colOrderId'),
      render: (r) => <span className="text-text-muted text-2xs">{r.order_id.slice(0, 12)}…</span>,
      align: 'left',
    },
  ];
}

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
  const t = useT();
  const columns = useOrdersColumns();
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingOrders')}
      </div>
    );
  }
  if (degraded) {
    return (
      <div className="text-center py-8 text-sm text-warning">
        {t('botDetail.tables.ordersDegraded')}
        {hint && <div className="text-2xs text-text-muted mt-1">{hint}</div>}
      </div>
    );
  }
  return (
    <DataTable
      rows={orders}
      columns={columns}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage={t('botDetail.tables.emptyOrders')}
    />
  );
}

// ── Funding ───────────────────────────────────────────────────────────

function useFundingColumns(): Column<FundingRow>[] {
  const t = useT();
  return [
    {
      key: 'time',
      header: t('botDetail.tables.colTime'),
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
      header: t('botDetail.tables.colRate'),
      render: (r) => `${(r.funding_rate * 100).toFixed(4)}%`,
      sortValue: (r) => r.funding_rate,
      align: 'right',
      mono: true,
    },
    {
      key: 'pos',
      header: t('botDetail.tables.colPosition'),
      render: (r) => formatSize(r.position_size),
      sortValue: (r) => r.position_size,
      align: 'right',
      mono: true,
    },
    {
      key: 'payment',
      header: t('botDetail.tables.colPayment'),
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
}

function FundingTable({
  funding,
  total,
  loading,
}: {
  funding: FundingRow[];
  total: number;
  loading: boolean;
}) {
  const t = useT();
  const columns = useFundingColumns();
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingFunding')}
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs">
        <span className="text-text-muted uppercase tracking-wider mr-2">
          {t('botDetail.tables.total')}
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
        columns={columns}
        pageSize={20}
        rowKey={(r) => r.id}
        emptyMessage={t('botDetail.tables.emptyFunding')}
      />
    </div>
  );
}

function BotDetailEquityCurve({ botId }: { botId: number }) {
  const t = useT();
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', botId],
    queryFn: () => api.getSnapshots(botId),
    staleTime: 5 * 60_000,
  });
  if (snapshotsQuery.isPending) {
    return (
      <div className="h-60 flex items-center justify-center text-sm text-text-muted animate-pulse">
        {t('botDetail.tables.loadingShort')}
      </div>
    );
  }
  return <EquityCurve snapshots={snapshotsQuery.data?.snapshots ?? []} />;
}

function ChartLegend() {
  const t = useT();
  return (
    <div className="hidden md:flex items-center gap-4 text-2xs">
      <LegendDot color="bg-success" label={t('botDetail.chart.legendBuy')} />
      <LegendDot color="bg-danger" label={t('botDetail.chart.legendSell')} />
      <LegendDot color="bg-slate-700" label={t('botDetail.chart.legendVirtual')} />
      <LegendDot color="bg-border-strong" label={t('botDetail.chart.legendFilled')} />
      <LegendDot color="bg-warning" label={t('botDetail.chart.legendPending')} />
      <LegendDot color="bg-primary" label={t('botDetail.chart.legendMark')} />
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
      <div className="h-[320px] sm:h-[420px] md:h-[560px] bg-bg-elevated rounded-lg" />
    </div>
  );
}

// Pull a numeric mark price out of the grid-state ticker payload.
// GRVT ticker shape varies; we look for the most likely fields.
// E.6: Wrapper that fetches fills and renders the heatmap.
function FillHeatmapSection({
  botId,
  levels,
  spacing,
}: {
  botId: number;
  levels: GridLevel[];
  spacing: number;
}) {
  const fillsQuery = useQuery({
    queryKey: ['fills', botId, 'heatmap'],
    queryFn: () => api.getFills(botId, { limit: 1000 }),
    staleTime: 30_000,
  });

  if (!fillsQuery.data?.fills?.length) return null;

  return (
    <FillHeatmap
      fills={fillsQuery.data.fills}
      levels={levels}
      spacing={spacing}
    />
  );
}

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
