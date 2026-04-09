import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/primitives/button';
import { Input } from '@/components/primitives/input';

const TERMS_TEXT = `By creating an account you confirm that:
- This software trades real cryptocurrency on GRVT perpetual futures.
- You can lose up to 100% of your invested capital. Leveraged trading carries significant risk.
- The operator of this service is NOT a financial advisor, broker, or custodian. You are solely responsible for your trades.
- The operator does NOT touch your funds. You provide your own GRVT API credentials and the bot trades on your sub-account.
- No profit guarantees of any kind are made or implied.
- The software is provided as-is, without warranty. Bugs, downtime, or exchange issues may cause losses.
- You will not hold the operator liable for any losses.`;

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);

  const passwordError =
    confirm && password !== confirm ? 'Passwords do not match' : undefined;
  const canSubmit =
    !!email && password.length >= 8 && password === confirm && accepted && !pending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    try {
      await signup(email, password);
      toast.success('Account created! Now connect your GRVT credentials.');
      navigate('/onboarding/grvt', { replace: true });
    } catch (err) {
      toast.error((err as Error).message || 'Signup failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-bg-base">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Create account
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Free grid trading bot for GRVT perpetual futures
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
          />
          <Input
            label="Password (min 8 characters)"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={passwordError}
            disabled={pending}
          />

          {/* Terms */}
          <div className="rounded-md border border-border-subtle bg-bg-surface p-3 space-y-2">
            <div className="text-2xs uppercase tracking-wider text-text-muted">
              Terms of use
            </div>
            <pre className="text-2xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">
              {TERMS_TEXT}
            </pre>
            <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer pt-1 border-t border-border-subtle">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
                disabled={pending}
              />
              <span>I have read and accept the terms above</span>
            </label>
          </div>

          {/* GRVT referral */}
          <div className="text-2xs text-text-muted text-center">
            You need a{' '}
            <a
              href="https://grvt.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              GRVT account
            </a>{' '}
            to use this bot. Sign up through our referral link for bonuses.
          </div>

          <Button
            variant="primary"
            type="submit"
            disabled={!canSubmit}
            className="w-full"
          >
            {pending ? 'Creating account...' : 'Create account'}
          </Button>
        </form>

        <p className="text-xs text-text-muted text-center">
          Already have an account?{' '}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
