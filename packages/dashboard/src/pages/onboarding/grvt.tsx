import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/primitives/button';
import { Input } from '@/components/primitives/input';
import { Card } from '@/components/primitives/card';

export function GrvtOnboardingPage() {
  const { refreshMe } = useAuth();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [tradingAddress, setTradingAddress] = useState('');
  const [accountId, setAccountId] = useState('');
  const [subAccountId, setSubAccountId] = useState('');
  const [pending, setPending] = useState(false);

  const canSave =
    apiKey.length > 0 &&
    /^0x[0-9a-fA-F]{64}$/.test(apiSecret) &&
    /^0x[0-9a-fA-F]{40}$/.test(tradingAddress) &&
    accountId.length > 0 &&
    subAccountId.length > 0 &&
    !pending;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setPending(true);
    try {
      await api.saveGrvtCredentials({
        apiKey,
        apiSecret,
        tradingAddress,
        accountId,
        subAccountId,
      });
      toast.success('GRVT credentials saved');
      await refreshMe();
      navigate('/', { replace: true });
    } catch (err) {
      toast.error((err as Error).message || 'Failed to save credentials');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-bg-base">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Connect GRVT
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Paste your GRVT API credentials to start trading
          </p>
        </div>

        <Card>
          <div className="text-2xs text-text-muted space-y-1 mb-4">
            <p>
              You need 4 values from your GRVT account. Go to{' '}
              <a
                href="https://grvt.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                grvt.io
              </a>{' '}
              &rarr; Settings &rarr; API Keys to generate them.
            </p>
            <p className="text-warning">
              Your private key (API Secret) is encrypted on the server
              using AES-256-GCM. It is never stored in plaintext and is
              only decrypted in memory when placing orders on GRVT.
            </p>
          </div>

          <form onSubmit={handleSave} className="space-y-3">
            <Input
              label="API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={pending}
              autoComplete="off"
            />
            <Input
              label="API Secret (private key, 0x...)"
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              disabled={pending}
              autoComplete="off"
              error={
                apiSecret && !/^0x[0-9a-fA-F]{64}$/.test(apiSecret)
                  ? '0x-prefixed 32-byte hex string expected'
                  : undefined
              }
            />
            <Input
              label="Trading Address (0x...)"
              value={tradingAddress}
              onChange={(e) => setTradingAddress(e.target.value)}
              disabled={pending}
              autoComplete="off"
              error={
                tradingAddress && !/^0x[0-9a-fA-F]{40}$/.test(tradingAddress)
                  ? '0x-prefixed Ethereum address expected'
                  : undefined
              }
            />
            <Input
              label="Account ID"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={pending}
              autoComplete="off"
            />
            <Input
              label="Sub-Account ID"
              value={subAccountId}
              onChange={(e) => setSubAccountId(e.target.value)}
              disabled={pending}
              autoComplete="off"
            />

            <Button
              variant="primary"
              type="submit"
              disabled={!canSave}
              className="w-full"
            >
              {pending ? 'Saving & testing...' : 'Save credentials'}
            </Button>
          </form>
        </Card>

        <p className="text-2xs text-text-muted text-center">
          You can update these later in Settings &rarr; GRVT Credentials.
        </p>
      </div>
    </div>
  );
}
