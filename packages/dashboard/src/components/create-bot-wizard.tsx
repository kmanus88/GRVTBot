// Create Bot Wizard — 4-step modal flow per design doc §7.3.
//
// Steps: Pair → Range → Config → Confirm
//
// Step 4 calls /bots/validate to compute the live preview, then on Confirm
// calls POST /bots which creates the bot in 'paused' state. The user is
// then navigated to the new bot's detail page where they can review the
// grid and explicitly Start it.
//
// Why paused-by-default: the engine's startBot() places real orders on
// GRVT. We don't want a misclick on "Create" to immediately spend money.

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Modal } from './primitives/modal';
import { Button } from './primitives/button';
import { Input } from './primitives/input';
import { Mono } from './primitives/mono';
import { api } from '@/lib/api-client';
import {
  formatPercent,
  formatPnl,
  formatSize,
  formatUsd,
} from '@/lib/format';
import type { ValidateBotInput, ValidateBotResult } from '@/lib/api-types';
import { cn } from '@/lib/cn';

interface CreateBotWizardProps {
  open: boolean;
  onClose: () => void;
}

interface WizardState {
  pair: string;
  direction: 'long' | 'short';
  lower: string; // strings while user types
  upper: string;
  grids: string;
  investment: string;
  leverage: string;
  acceptedRisk: boolean;
  compoundPct: string;
}

const INITIAL_STATE: WizardState = {
  pair: 'ETH_USDT_Perp',
  direction: 'long',
  lower: '1800',
  upper: '2450',
  grids: '93',
  investment: '1085',
  leverage: '10',
  acceptedRisk: false,
  compoundPct: '0',
};

const PAIRS = [
  { value: 'ETH_USDT_Perp', label: 'ETH-USDT-Perp' },
  { value: 'BTC_USDT_Perp', label: 'BTC-USDT-Perp' },
];

type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ['Pair', 'Range', 'Config', 'Confirm'];

export function CreateBotWizard({ open, onClose }: CreateBotWizardProps) {
  const [step, setStep] = useState<Step>(0);
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [validated, setValidated] = useState<ValidateBotResult | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const validateMutation = useMutation({
    mutationFn: (input: ValidateBotInput) => api.validateBot(input),
    onSuccess: (result) => {
      setValidated(result);
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: ValidateBotInput) => api.createBot(input),
    onSuccess: (result) => {
      toast.success(`Bot ${result.id} created (paused). Review and Start when ready.`);
      // Refresh the bots list so the new card appears immediately on Overview.
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      // Navigate to the new bot's detail page so the user can review +
      // explicitly press Start.
      navigate(`/bots/${result.id}`);
      handleClose();
    },
    onError: (err: Error) => {
      toast.error(`Bot creation failed: ${err.message}`);
    },
  });

  // Reset on close
  function handleClose() {
    setStep(0);
    setState(INITIAL_STATE);
    setValidated(null);
    validateMutation.reset();
    createMutation.reset();
    onClose();
  }

  function handleCreate() {
    if (!validated) return;
    const compoundPct = Math.min(100, Math.max(0, parseInt(state.compoundPct || '0', 10)));
    createMutation.mutate({
      pair: validated.pair,
      direction: validated.direction,
      lower_price: validated.input.lower,
      upper_price: validated.input.upper,
      num_grids: validated.input.grids,
      investment_usdt: validated.input.investment,
      leverage: validated.input.leverage,
      ...(compoundPct > 0 ? { compound_pct: compoundPct } : {}),
    } as any);
  }

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }));
    // Only invalidate the cached /validate result when a CONFIG field
    // changes — ticking the risk checkbox on step 4 must NOT reset
    // validated, otherwise StepConfirm re-renders to null (line 469)
    // and the checkbox disappears mid-tick, breaking the wizard.
    if (key !== 'acceptedRisk' && key !== 'compoundPct') {
      setValidated(null);
    }
  }

  // Trigger validate when entering Step 3 (Confirm).
  function next() {
    if (step === 2) {
      const input: ValidateBotInput = {
        pair: state.pair,
        direction: state.direction,
        lower_price: parseFloat(state.lower),
        upper_price: parseFloat(state.upper),
        num_grids: parseInt(state.grids, 10),
        investment_usdt: parseFloat(state.investment),
        leverage: parseInt(state.leverage, 10),
      };
      validateMutation.mutate(input);
    }
    setStep((s) => Math.min(3, s + 1) as Step);
  }

  function back() {
    setStep((s) => Math.max(0, s - 1) as Step);
  }

  const canNext = (() => {
    if (step === 0) return !!state.pair;
    if (step === 1) {
      const lo = parseFloat(state.lower);
      const hi = parseFloat(state.upper);
      return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo;
    }
    if (step === 2) {
      const inv = parseFloat(state.investment);
      const grids = parseInt(state.grids, 10);
      const lev = parseInt(state.leverage, 10);
      return inv > 0 && grids >= 2 && grids <= 95 && lev >= 1 && lev <= 50;
    }
    if (step === 3) return state.acceptedRisk;
    return false;
  })();

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="wide"
      title="Create a new bot"
      description={`Step ${step + 1} of 4 — ${STEP_LABELS[step]}`}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          {step > 0 && (
            <Button variant="secondary" onClick={back}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button onClick={next} disabled={!canNext}>
              Continue
              <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canNext || createMutation.isPending}
              onClick={handleCreate}
            >
              <Check className="size-4" />
              {createMutation.isPending ? 'Creating…' : 'Create bot (paused)'}
            </Button>
          )}
        </>
      }
    >
      <Stepper step={step} />
      <div className="mt-6">
        {step === 0 && <StepPair state={state} update={update} />}
        {step === 1 && <StepRange state={state} update={update} />}
        {step === 2 && <StepConfig state={state} update={update} />}
        {step === 3 && (
          <StepConfirm
            state={state}
            update={update}
            validated={validated}
            isValidating={validateMutation.isPending}
            error={validateMutation.error as Error | null}
          />
        )}
      </div>
    </Modal>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {STEP_LABELS.map((label, i) => {
        const active = i === step;
        const completed = i < step;
        return (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div
              className={cn(
                'size-6 rounded-full flex items-center justify-center text-2xs font-semibold',
                completed && 'bg-success text-bg-base',
                active && 'bg-primary text-bg-base',
                !active && !completed && 'bg-bg-muted text-text-muted'
              )}
            >
              {completed ? <Check className="size-3" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-2xs uppercase tracking-wider',
                active ? 'text-text-primary font-semibold' : 'text-text-muted'
              )}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <div className="flex-1 h-px bg-border-subtle" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Pair selector ────────────────────────────────────────────────

function StepPair({
  state,
  update,
}: {
  state: WizardState;
  update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Select instrument
      </h3>
      <div className="grid grid-cols-2 gap-3">
        {PAIRS.map((p) => {
          const selected = state.pair === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => update('pair', p.value)}
              className={cn(
                'p-4 rounded-md border text-left transition-colors',
                selected
                  ? 'border-primary bg-primary-soft text-text-primary'
                  : 'border-border-subtle bg-bg-surface hover:border-border-default'
              )}
            >
              <div className="font-semibold text-sm">{p.label}</div>
              <div className="text-2xs text-text-muted mt-1">
                Min size 0.001 · Max leverage 50x
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-2xs text-text-muted">
        ⓘ More pairs coming. ETH and BTC perp are supported in v0.
      </p>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">
          Direction
        </h3>
        <div className="flex gap-2">
          {(['long', 'short'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => update('direction', d)}
              className={cn(
                'flex-1 h-10 rounded-md border text-sm font-semibold uppercase tracking-wider',
                state.direction === d
                  ? d === 'long'
                    ? 'border-success bg-success-soft text-success'
                    : 'border-danger bg-danger-soft text-danger'
                  : 'border-border-subtle text-text-muted hover:border-border-default'
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Range ────────────────────────────────────────────────────────

function StepRange({
  state,
  update,
}: {
  state: WizardState;
  update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void;
}) {
  const lo = parseFloat(state.lower);
  const hi = parseFloat(state.upper);
  const valid = Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo;
  const widthPct = valid ? (((hi - lo) / lo) * 100).toFixed(1) : '—';

  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Set price range
      </h3>
      <p className="text-xs text-text-muted mb-4">
        Define the price band where the bot will place orders. Wider ranges
        trade less often but are safer; narrow ranges fill faster but exit the
        range sooner.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Lower price (USDT)"
          numeric
          inputMode="decimal"
          value={state.lower}
          onChange={(e) => update('lower', e.target.value)}
        />
        <Input
          label="Upper price (USDT)"
          numeric
          inputMode="decimal"
          value={state.upper}
          onChange={(e) => update('upper', e.target.value)}
        />
      </div>
      {valid ? (
        <p className="mt-4 text-xs text-text-muted">
          Range width: <Mono className="text-text-secondary">{widthPct}%</Mono>
        </p>
      ) : (
        <p className="mt-4 text-xs text-danger">
          Lower price must be greater than 0 and below upper price.
        </p>
      )}
    </div>
  );
}

// ── Step 3: Config ───────────────────────────────────────────────────────

function StepConfig({
  state,
  update,
}: {
  state: WizardState;
  update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Capital and grid configuration
      </h3>
      <div className="grid grid-cols-3 gap-4">
        <Input
          label="Investment (USDT)"
          numeric
          inputMode="decimal"
          value={state.investment}
          onChange={(e) => update('investment', e.target.value)}
        />
        <Input
          label="Leverage"
          numeric
          inputMode="numeric"
          value={state.leverage}
          onChange={(e) => update('leverage', e.target.value)}
          helper="1x – 50x"
        />
        <Input
          label="Grid count"
          numeric
          inputMode="numeric"
          value={state.grids}
          onChange={(e) => update('grids', e.target.value)}
          helper="2 – 95"
        />
      </div>
      <div className="mt-4">
        <Input
          label="Reinvest profit %"
          numeric
          inputMode="numeric"
          value={state.compoundPct}
          onChange={(e) => update('compoundPct', e.target.value)}
          helper="0 = disabled, 100 = reinvest all profit"
        />
      </div>
      <p className="mt-4 text-xs text-text-muted">
        Effective notional ={' '}
        <Mono className="text-text-secondary">
          {formatUsd(
            parseFloat(state.investment || '0') * parseInt(state.leverage || '0', 10)
          )}
        </Mono>
        . The next step validates the config and computes spacing, qty/level
        and liquidation distance.
      </p>
    </div>
  );
}

// ── Step 4: Confirm ──────────────────────────────────────────────────────

function StepConfirm({
  state,
  update,
  validated,
  isValidating,
  error,
}: {
  state: WizardState;
  update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void;
  validated: ValidateBotResult | null;
  isValidating: boolean;
  error: Error | null;
}) {
  if (isValidating) {
    return (
      <div className="text-sm text-text-muted py-8 text-center animate-pulse">
        Validating configuration…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-danger/40 bg-danger-soft/30 p-4">
        <div className="flex items-start gap-2 text-danger">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold">Validation failed</div>
            <div className="text-xs mt-1">{error.message}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!validated) return null;

  const c = validated.computed;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">
        Review and create
      </h3>

      <SummaryGrid>
        <SummaryItem label="Pair" value={validated.pair} mono={false} />
        <SummaryItem label="Direction" value={validated.direction.toUpperCase()} mono={false} />
        <SummaryItem label="Leverage" value={`${validated.input.leverage}x`} />
        <SummaryItem
          label="Range"
          value={`${formatUsd(validated.input.lower)} — ${formatUsd(validated.input.upper)}`}
        />
        <SummaryItem label="Grids" value={`${validated.input.grids} levels`} />
        <SummaryItem label="Investment" value={formatUsd(validated.input.investment)} />
      </SummaryGrid>

      <hr className="border-border-subtle" />

      <h4 className="text-2xs uppercase tracking-wider text-text-muted">
        Computed parameters
      </h4>
      <SummaryGrid>
        <SummaryItem label="Spacing" value={`${formatUsd(c.spacing)} (${c.spacingPct}%)`} />
        <SummaryItem label="Qty / level" value={formatSize(c.qtyPerLevel)} />
        <SummaryItem label="Notional" value={formatUsd(c.notional)} />
        <SummaryItem label="Profit / round-trip" value={formatPnl(c.profitPerRoundTrip)} />
        <SummaryItem
          label="Est. liquidation"
          value={formatUsd(c.liquidationEstimate)}
        />
        <SummaryItem
          label="Liq. distance"
          value={formatPercent(-c.liqDistancePct)}
        />
      </SummaryGrid>

      {validated.warnings.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-soft/30 p-3">
          <div className="flex items-start gap-2 text-warning text-xs">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Warnings</div>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {validated.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-md border border-border-default bg-bg-surface p-3 text-xs text-text-muted">
        ⓘ The bot will be created in <strong className="text-text-secondary">paused</strong>{' '}
        state. No orders will be placed on GRVT until you explicitly press
        Start from the bot detail page after reviewing the configuration.
      </div>

      <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={state.acceptedRisk}
          onChange={(e) => update('acceptedRisk', e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          I understand this bot will use real funds and risk liquidation up to{' '}
          <Mono>{formatUsd(validated.input.investment)}</Mono>.
        </span>
      </label>
    </div>
  );
}

function SummaryGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-6 gap-y-2">{children}</dl>;
}

function SummaryItem({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border-subtle pb-1.5">
      <dt className="text-2xs uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd className={mono ? 'font-mono text-xs text-text-primary' : 'text-xs text-text-primary'}>
        {value}
      </dd>
    </div>
  );
}
