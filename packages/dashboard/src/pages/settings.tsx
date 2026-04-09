import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';
import { Card } from '@/components/primitives/card';
import { Button } from '@/components/primitives/button';
import { Mono } from '@/components/primitives/mono';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Account */}
      <Card>
        <h2 className="text-sm font-semibold mb-3">Account</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            Email
          </dt>
          <dd className="font-mono text-text-secondary">{user?.email}</dd>
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            Role
          </dt>
          <dd className="text-text-secondary">
            {user?.isAdmin ? 'Admin' : 'User'}
          </dd>
        </dl>
        <div className="mt-4">
          <Button
            variant="secondary"
            onClick={() => {
              logout();
              navigate('/login', { replace: true });
            }}
          >
            Log out
          </Button>
        </div>
      </Card>

      {/* GRVT Credentials */}
      <Card>
        <h2 className="text-sm font-semibold mb-3">GRVT Credentials</h2>
        {user?.hasGrvtCreds ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="size-2 rounded-full bg-success" />
              <span className="text-text-secondary">Connected</span>
            </div>
            <p className="text-2xs text-text-muted">
              Your GRVT API credentials are stored encrypted on the server
              (AES-256-GCM). To update them, click the button below.
            </p>
            <Button
              variant="secondary"
              onClick={() => navigate('/onboarding/grvt')}
            >
              Update credentials
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="size-2 rounded-full bg-warning" />
              <span className="text-warning">Not connected</span>
            </div>
            <p className="text-2xs text-text-muted">
              Connect your GRVT API credentials to start creating bots.
            </p>
            <Button
              variant="primary"
              onClick={() => navigate('/onboarding/grvt')}
            >
              Connect GRVT
            </Button>
          </div>
        )}
      </Card>

      {/* Connection info */}
      <Card>
        <h2 className="text-sm font-semibold mb-2">Connection</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            API base
          </dt>
          <dd className="font-mono text-text-secondary">
            {import.meta.env.VITE_API_BASE_URL || '(same origin)'}
          </dd>
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            Auth
          </dt>
          <dd className="font-mono text-text-secondary">
            JWT (<Mono>userId={user?.id}</Mono>)
          </dd>
        </dl>
      </Card>

      {/* Referral */}
      <Card>
        <h2 className="text-sm font-semibold mb-2">GRVT Referral</h2>
        <p className="text-2xs text-text-muted">
          This bot is free to use. If you don't have a GRVT account yet,
          sign up through our referral link for bonuses:
        </p>
        <a
          href="https://grvt.io"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-2 text-sm text-primary hover:underline"
        >
          Sign up on GRVT &rarr;
        </a>
      </Card>
    </div>
  );
}
