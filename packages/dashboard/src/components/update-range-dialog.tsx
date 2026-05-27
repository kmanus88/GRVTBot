// UpdateRangeDialog — operator escape hatch when price drifts out of the
// current grid range. Two-phase: live preview from the server-side
// plan builder, then explicit commit. The user always sees exactly
// what will happen (orders to cancel, ETH to auto-buy, slippage cost)
// before pressing Apply.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { Modal } from '@/components/primitives/modal';
import { Input } from '@/components/primitives/input';
import { Button } from '@/components/primitives/button';
import { Mono } from '@/components/primitives/mono';
import { api } from '@/lib/api-client';
import { formatUsd } from '@/lib/format';
import type { BotSummary, RangeUpdatePlan } from '@/lib/api-types';
import { useT } from '@/i18n';

interface UpdateRangeDialogProps {
  open: boolean;
  onClose: () => void;
  bot: BotSummary;
  markPrice: number | null;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function UpdateRangeDialog({
  open,
  onClose,
  bot,
  markPrice,
}: UpdateRangeDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();

  const [lower, setLower] = useState<string>('');
  const [upper, setUpper] = useState<string>('');
  const [touchedLower, setTouchedLower] = useState(false);
  const [touchedUpper, setTouchedUpper] = useState(false);

  useEffect(() => {
    if (open) {
      setLower(String(bot.lower_price));
      setUpper(String(bot.upper_price));
      setTouchedLower(false);
      setTouchedUpper(false);
    }
  }, [open, bot.lower_price, bot.upper_price]);

  const lowerNum = parseFloat(lower);
  const upperNum = parseFloat(upper);
  const lowerValid = Number.isFinite(lowerNum) && lowerNum > 0;
  const upperValid = Number.isFinite(upperNum) && upperNum > 0;
  const orderingValid = lowerValid && upperValid && lowerNum < upperNum;

  const lowerError =
    touchedLower && !lowerValid
      ? t('updateRange.mustBePositive')
      : touchedLower && lowerValid && upperValid && lowerNum >= upperNum
        ? t('updateRange.mustBeLessThanUpper')
        : undefined;
  const upperError =
    touchedUpper && !upperValid ? t('updateRange.mustBePositive') : undefined;

  const debouncedLower = useDebounced(lowerNum, 400);
  const debouncedUpper = useDebounced(upperNum, 400);
  const debouncedValid =
    Number.isFinite(debouncedLower) &&
    Number.isFinite(debouncedUpper) &&
    debouncedLower > 0 &&
    debouncedUpper > 0 &&
    debouncedLower < debouncedUpper;

  const previewQuery = useQuery({
    queryKey: ['range-preview', bot.id, debouncedLower, debouncedUpper],
    queryFn: () =>
      api.previewBotRangeUpdate(bot.id, {
        lowerPrice: debouncedLower,
        upperPrice: debouncedUpper,
      }),
    enabled: open && debouncedValid,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  const plan: RangeUpdatePlan | null = previewQuery.data?.plan ?? null;

  const ordersAtStart = plan?.ordersToCancel ?? 0;
  const totalTarget = plan?.levelsToCreate ?? 0;

  const mutation = useMutation({
    mutationFn: () =>
      api.updateBotRange(bot.id, { lowerPrice: lowerNum, upperPrice: upperNum }),
    onSuccess: () => {
      toast.success(
        t('updateRange.successToast', {
          lower: formatUsd(lowerNum),
          upper: formatUsd(upperNum),
        })
      );
      void queryClient.invalidateQueries({ queryKey: ['bot', bot.id] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', bot.id] });
      onClose();
    },
    onError: (err: Error) =>
      toast.error(t('updateRange.failedToast', { msg: err.message })),
  });

  const progressQuery = useQuery({
    queryKey: ['range-update-progress', bot.id],
    queryFn: () => api.getGridState(bot.id),
    enabled: mutation.isPending,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  });

  const liveOrderCount = progressQuery.data?.openOrders.length ?? ordersAtStart;
  let progressPct = 0;
  let phaseText = t('updateRange.phaseStarting');
  if (mutation.isPending && totalTarget > 0) {
    if (liveOrderCount > 0 && liveOrderCount >= ordersAtStart * 0.95) {
      phaseText = t('updateRange.phaseCancelling', {
        n: liveOrderCount,
        total: ordersAtStart,
      });
      progressPct = 5;
    } else if (liveOrderCount > totalTarget * 0.5 && liveOrderCount < ordersAtStart) {
      phaseText = t('updateRange.phaseCancellingShort');
      progressPct = 25;
    } else if (liveOrderCount === 0 || liveOrderCount < totalTarget * 0.1) {
      phaseText = plan?.autoBuy
        ? t('updateRange.phaseBuying', { size: plan.autoBuy.size.toFixed(2) })
        : t('updateRange.phasePlacingShort');
      progressPct = 50;
    } else {
      const placed = liveOrderCount;
      const placePct = Math.min(100, (placed / totalTarget) * 100);
      phaseText = t('updateRange.phasePlacing', {
        n: placed,
        total: totalTarget,
      });
      progressPct = 50 + placePct * 0.5;
    }
  }

  const hasViolations = (plan?.safetyViolations.length ?? 0) > 0;
  const canSubmit =
    orderingValid &&
    plan !== null &&
    !hasViolations &&
    !plan.noop &&
    !mutation.isPending &&
    !previewQuery.isFetching;

  const submitLabel = useMemo(() => {
    if (mutation.isPending) return t('updateRange.submitUpdating');
    if (previewQuery.isFetching) return t('updateRange.submitCalculating');
    if (plan?.noop) return t('updateRange.submitNoChange');
    if (hasViolations) return t('updateRange.submitCannot');
    return t('updateRange.submitApply');
  }, [mutation.isPending, previewQuery.isFetching, plan?.noop, hasViolations, t]);

  function handleSubmit() {
    setTouchedLower(true);
    setTouchedUpper(true);
    if (!canSubmit) return;
    mutation.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={mutation.isPending ? () => {} : onClose}
      title={t('updateRange.title')}
      description={`${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            {t('updateRange.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3 text-2xs uppercase tracking-wider">
          <div className="flex-1">
            <div className="text-text-muted">{t('updateRange.currentRange')}</div>
            <div className="text-text-primary text-sm normal-case tracking-normal">
              <Mono>
                {formatUsd(bot.lower_price)} — {formatUsd(bot.upper_price)}
              </Mono>
            </div>
          </div>
          <ArrowRight className="size-4 text-text-muted shrink-0" />
          <div className="flex-1">
            <div className="text-text-muted">{t('updateRange.markPrice')}</div>
            <div className="text-sm normal-case tracking-normal">
              {markPrice !== null ? (
                <Mono
                  className={
                    markPrice < bot.lower_price || markPrice > bot.upper_price
                      ? 'text-danger'
                      : 'text-text-primary'
                  }
                >
                  {formatUsd(markPrice)}
                </Mono>
              ) : (
                <span className="text-text-disabled">—</span>
              )}
            </div>
          </div>
        </div>

        {markPrice !== null &&
          (markPrice < bot.lower_price || markPrice > bot.upper_price) && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-warning-soft border border-warning/30">
              <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
              <div className="text-2xs text-warning-strong">
                <strong>{t('updateRange.outOfGridTitle')}</strong>{' '}
                {t('updateRange.outOfGridBody')}
              </div>
            </div>
          )}

        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t('updateRange.newLowerPrice')}
            numeric
            inputMode="decimal"
            value={lower}
            onChange={(e) => setLower(e.target.value)}
            onBlur={() => setTouchedLower(true)}
            error={lowerError}
            disabled={mutation.isPending}
          />
          <Input
            label={t('updateRange.newUpperPrice')}
            numeric
            inputMode="decimal"
            value={upper}
            onChange={(e) => setUpper(e.target.value)}
            onBlur={() => setTouchedUpper(true)}
            error={upperError}
            disabled={mutation.isPending}
          />
        </div>

        {mutation.isPending && (
          <div className="rounded-md border border-primary/40 bg-primary-soft/30 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-text-primary font-semibold">
                <Loader2 className="size-4 animate-spin text-primary" />
                {phaseText}
              </div>
              <Mono className="text-text-secondary">
                {Math.round(progressPct)}%
              </Mono>
            </div>
            <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-2xs text-text-muted">
              {t('updateRange.progressNote')}
            </p>
          </div>
        )}

        <PreviewArea
          plan={plan}
          fetching={previewQuery.isFetching}
          error={previewQuery.error as Error | null}
          formValid={orderingValid && debouncedValid}
        />
      </div>
    </Modal>
  );
}

interface PreviewAreaProps {
  plan: RangeUpdatePlan | null;
  fetching: boolean;
  error: Error | null;
  formValid: boolean;
}

function PreviewArea({ plan, fetching, error, formValid }: PreviewAreaProps) {
  const t = useT();
  if (!formValid) {
    return (
      <div className="rounded-md border border-dashed border-border-subtle bg-bg-surface p-3 text-2xs text-text-muted text-center">
        {t('updateRange.enterRange')}
      </div>
    );
  }
  if (fetching && !plan) {
    return (
      <div className="rounded-md border border-border-subtle bg-bg-surface p-3 text-xs text-text-muted flex items-center gap-2 justify-center">
        <Loader2 className="size-4 animate-spin" />
        {t('updateRange.calculating')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 p-3 rounded-md bg-danger-soft border border-danger/30">
        <AlertTriangle className="size-4 text-danger shrink-0 mt-0.5" />
        <div className="text-2xs text-danger-strong">
          <strong>{t('updateRange.previewFailedPrefix')}</strong> {error.message}
        </div>
      </div>
    );
  }
  if (!plan) return null;

  return (
    <div className="space-y-3">
      {plan.safetyViolations.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-danger-soft border border-danger/30">
          <AlertTriangle className="size-4 text-danger shrink-0 mt-0.5" />
          <div className="text-2xs text-danger-strong space-y-1">
            <div className="font-semibold">{t('updateRange.cannotApplyTitle')}</div>
            <ul className="list-disc list-inside space-y-0.5">
              {plan.safetyViolations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {plan.noop && plan.safetyViolations.length === 0 && (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3 text-2xs text-text-muted text-center">
          {t('updateRange.rangeUnchanged')}
        </div>
      )}

      {!plan.noop && plan.safetyViolations.length === 0 && (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3 space-y-3">
          <div className="text-2xs uppercase tracking-wider text-text-muted">
            {t('updateRange.previewTitle')}
          </div>

          <dl className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
            <dt className="text-text-muted">{t('updateRange.newRange')}</dt>
            <dd className="text-right text-text-primary">
              <Mono>
                {formatUsd(plan.newRange.lower)} — {formatUsd(plan.newRange.upper)}
              </Mono>
            </dd>
            <dt className="text-text-muted">{t('updateRange.totalLevels')}</dt>
            <dd className="text-right text-text-primary">
              <Mono>{plan.newTotalLevels}</Mono>
            </dd>
            <dt className="text-text-muted">{t('updateRange.spacing')}</dt>
            <dd className="text-right text-text-primary">
              <Mono>{formatUsd(plan.newSpacing)}</Mono>
            </dd>
            <dt className="text-text-muted">{t('updateRange.buyLevels')}</dt>
            <dd className="text-right text-success">
              <Mono>{plan.newBuyLevels}</Mono>
            </dd>
            <dt className="text-text-muted">{t('updateRange.sellLevels')}</dt>
            <dd className="text-right text-danger">
              <Mono>{plan.newSellLevels}</Mono>
            </dd>
            <dt className="text-text-muted">{t('updateRange.ordersToCancel')}</dt>
            <dd className="text-right text-text-primary">
              <Mono>{plan.ordersToCancel}</Mono>
            </dd>
          </dl>

          {plan.autoBuy && (
            <div className="border-t border-border-subtle pt-3">
              <div className="text-2xs uppercase tracking-wider text-warning mb-1.5">
                {t('updateRange.willMarketBuy')}
              </div>
              <dl className="grid grid-cols-2 gap-y-1 gap-x-4 text-xs">
                <dt className="text-text-muted">{t('updateRange.autoBuySize')}</dt>
                <dd className="text-right">
                  <Mono className="text-text-primary">
                    {plan.autoBuy.size.toFixed(4)} ETH
                  </Mono>
                </dd>
                <dt className="text-text-muted">{t('updateRange.autoBuyAtPrice')}</dt>
                <dd className="text-right">
                  <Mono className="text-text-primary">
                    ~{formatUsd(plan.autoBuy.estimatedPrice)}
                  </Mono>
                </dd>
                <dt className="text-text-muted">{t('updateRange.autoBuyTotalCost')}</dt>
                <dd className="text-right">
                  <Mono className="text-warning">
                    ~{formatUsd(plan.autoBuy.estimatedCost)}
                  </Mono>
                </dd>
                <dt className="text-text-muted">{t('updateRange.autoBuySlippage')}</dt>
                <dd className="text-right">
                  <Mono className="text-text-muted">
                    ~{formatUsd(plan.autoBuy.estimatedSlippageUsd)}
                  </Mono>
                </dd>
              </dl>
              <p className="text-2xs text-text-muted mt-2">
                {t('updateRange.autoBuyHelp')}
              </p>
            </div>
          )}

          {plan.ethExcess > 0 && (
            <div className="border-t border-border-subtle pt-3 text-2xs text-text-muted">
              {t('updateRange.excessPrefix')}{' '}
              <Mono className="text-text-primary">
                {plan.ethExcess.toFixed(4)} ETH
              </Mono>
              {t('updateRange.excessSuffix')}
            </div>
          )}

          {plan.warnings.length > 0 && !plan.autoBuy && plan.ethExcess === 0 && (
            <div className="border-t border-border-subtle pt-3 text-2xs text-text-muted space-y-0.5">
              {plan.warnings.map((w) => (
                <div key={w}>· {w}</div>
              ))}
            </div>
          )}

          <p className="text-2xs text-text-muted pt-2 border-t border-border-subtle">
            {t('updateRange.operationNote')}
          </p>
        </div>
      )}
    </div>
  );
}
