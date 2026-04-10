// Bots page — flat BotCard grid + create CTA. The Overview page also
// shows bots, but with the aggregate stat strip on top; this page is
// the focused list view for when you only want bot cards.

import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/primitives/button';
import { Card } from '@/components/primitives/card';
import { BotCard } from '@/components/bot-card';

const CreateBotWizard = lazy(() =>
  import('@/components/create-bot-wizard').then((m) => ({
    default: m.CreateBotWizard,
  }))
);

export function BotsListPage() {
  const botsQuery = useQuery({
    queryKey: ['bots'],
    queryFn: () => api.getBots(),
    staleTime: 5_000,
  });

  // Per-card WS subscription lives inside BotCard now, so this page
  // doesn't need a global hardcoded bot:N channel.

  const [wizardOpen, setWizardOpen] = useState(false);

  if (botsQuery.isPending) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="h-8 w-32 bg-bg-elevated rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 bg-bg-elevated rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (botsQuery.isError) {
    return (
      <Card className="border-danger/40">
        <h2 className="text-lg font-semibold text-danger mb-2">
          Failed to load bots
        </h2>
        <p className="text-sm text-text-muted">
          {(botsQuery.error as Error).message}
        </p>
      </Card>
    );
  }

  const allBots = botsQuery.data?.bots ?? [];
  const bots = allBots.filter((b) => b.status !== 'stopped');
  const stoppedBots = allBots.filter((b) => b.status === 'stopped');
  const runningCount = bots.filter((b) => b.status === 'running').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bots</h1>
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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {bots.map((bot) => (
          <BotCard key={bot.id} bot={bot} />
        ))}
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

      {stoppedBots.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-text-secondary">
              History
            </h2>
            <p className="text-sm text-text-muted mt-0.5">
              {stoppedBots.length} closed{' '}
              {stoppedBots.length === 1 ? 'bot' : 'bots'}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 opacity-75">
            {stoppedBots.map((bot) => (
              <BotCard key={bot.id} bot={bot} />
            ))}
          </div>
        </div>
      )}

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
