// Overview page — multi-bot dashboard with stat-strip + BotCard grid + create CTA.

import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api-client';
import { useWsChannel } from '@/lib/use-ws-channel';
import { formatPercent, formatPnl, formatUsd } from '@/lib/format';
import { StatCard } from '@/components/primitives/stat-card';
import { Delta } from '@/components/primitives/delta';
import { Button } from '@/components/primitives/button';
import { Card } from '@/components/primitives/card';
import { BotCard } from '@/components/bot-card';
import type { BotSummary } from '@/lib/api-types';

// Lazy: only loaded when the user clicks "New bot" — keeps the wizard's
// validation hooks + Modal off the initial page payload.
const CreateBotWizard = lazy(() =>
  import('@/components/create-bot-wizard').then((m) => ({
    default: m.CreateBotWizard,
  }))
);

interface BotTick {
  id: number;
  status: BotSummary['status'];
  positionSize: number;
  avgEntryPrice: number;
  gridProfit: number;
  trendPnl: number;
  totalPnl: number;
}

export function OverviewPage() {
  const botsQuery = useQuery({
    queryKey: ['bots'],
    queryFn: () => api.getBots(),
    staleTime: 5_000,
  });

  // Real lifetime grid profit via spread-pair matching of fills_archive
  // (post bot.created_at). Same algorithm the engine's
  // calculateRealGridProfit() uses, but operating over the FULL
  // backfilled fill history instead of just the last ~430 fills.
  // Decoupled from compound rebalances and external margin transfers
  // because it only counts trade pairs, not balance changes.
  const realizedQuery = useQuery({
    queryKey: ['realized-summary', 42],
    queryFn: () => api.getRealizedSummary(42),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Live ticks per bot, keyed by id.
  const [ticks, setTicks] = useState<Record<number, BotTick>>({});
  // For now we only listen to bot:42; multi-bot WS subscription comes when
  // there are actually multiple bots.
  useWsChannel<BotTick>('bot:42', (msg) => {
    if (msg.type === 'tick') {
      setTicks((t) => ({ ...t, [msg.data.id]: msg.data }));
    }
  });

  const [wizardOpen, setWizardOpen] = useState(false);

  if (botsQuery.isPending) return <PageSkeleton />;
  if (botsQuery.isError) {
    return (
      <Card className="border-danger/40">
        <h2 className="text-lg font-semibold text-danger mb-2">
          Failed to load bots
        </h2>
        <p className="text-sm text-text-muted">
          {(botsQuery.error as Error).message}
        </p>
        <p className="text-xs text-text-muted mt-3">
          Check that <code className="font-mono">VITE_DASHBOARD_API_KEY</code>{' '}
          is set in <code className="font-mono">.env.local</code>.
        </p>
      </Card>
    );
  }

  const bots = botsQuery.data?.bots ?? [];

  // Aggregate equity / pnl across all bots, preferring tick data when present.
  // Aggregate, source-of-truth-aware:
  //   - invested:    bot.investment_usdt (immutable, set at creation)
  //   - unrealized:  bot.trend_pnl_usdt or live tick (mark-to-market on
  //                  the open position; the bot already computes this
  //                  from the live ticker)
  //   - realized:    FIFO sum from fills_archive, NET of fees, via the
  //                  /realized-summary endpoint. Fallback to legacy
  //                  bot.grid_profit_usdt only while the query is in
  //                  flight so the card never blanks.
  //   - totalPnl:    realized + unrealized (rebuilt from real numbers,
  //                  NOT from the legacy bot.total_pnl_usdt which is
  //                  stale because it stores grid_profit + trend_pnl)
  //   - equity:      invested + totalPnl
  let totalInvested = 0;
  let totalUnrealized = 0;
  let runningCount = 0;
  for (const bot of bots) {
    const tick = ticks[bot.id];
    const status = tick?.status ?? bot.status;
    const unrealized = tick?.trendPnl ?? bot.trend_pnl_usdt;
    totalInvested += bot.investment_usdt;
    totalUnrealized += unrealized;
    if (status === 'running') runningCount++;
  }

  const totalRealized =
    realizedQuery.data?.netGridProfit ??
    bots.reduce((acc, b) => acc + b.grid_profit_usdt, 0);
  const totalPnl = totalRealized + totalUnrealized;
  const totalEquity = totalInvested + totalPnl;
  const totalPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Page header + create CTA */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-text-muted mt-1">
            {bots.length} {bots.length === 1 ? 'bot' : 'bots'} ·{' '}
            <span className="text-success">{runningCount} running</span>
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="size-4" />
          New bot
        </Button>
      </div>

      {/* Aggregate stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border-subtle rounded-lg overflow-hidden">
        <StatCard
          label="Total equity"
          value={formatUsd(totalEquity)}
          delta={<Delta value={totalPct} format={formatPercent} />}
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
        <StatCard label="Realized" value={formatPnl(totalRealized)} />
        <StatCard
          label="Unrealized"
          value={
            <span
              className={
                totalUnrealized > 0
                  ? 'text-success'
                  : totalUnrealized < 0
                    ? 'text-danger'
                    : 'text-text-primary'
              }
            >
              {formatPnl(totalUnrealized)}
            </span>
          }
        />
      </div>

      {/* BotCard grid */}
      <div>
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Bots
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} tick={ticks[bot.id] ?? null} />
          ))}
          {/* Create-new tile */}
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="rounded-lg border border-dashed border-border-default hover:border-primary hover:bg-primary-soft/30 transition-colors p-5 min-h-[280px] flex flex-col items-center justify-center gap-3 text-text-muted hover:text-primary"
          >
            <div className="size-12 rounded-full bg-bg-elevated flex items-center justify-center">
              <Plus className="size-6" />
            </div>
            <div className="text-sm font-semibold">Create new bot</div>
            <div className="text-2xs text-center max-w-[200px]">
              Launch a new grid bot with the wizard
            </div>
          </button>
        </div>
      </div>

      {wizardOpen && (
        <Suspense fallback={null}>
          <CreateBotWizard
            open={wizardOpen}
            onClose={() => setWizardOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="h-8 w-48 bg-bg-elevated rounded" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border-subtle rounded-lg overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-bg-elevated" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-72 bg-bg-elevated rounded-lg" />
        ))}
      </div>
    </div>
  );
}
