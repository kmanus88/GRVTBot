import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';

interface Props {
  children: React.ReactNode;
  requireGrvt?: boolean;
}

export function ProtectedRoute({ children, requireGrvt = true }: Props) {
  const { user, token, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-text-muted animate-pulse">
        Loading...
      </div>
    );
  }

  if (!token) return <Navigate to="/login" replace />;
  if (!user) return <Navigate to="/login" replace />;
  if (requireGrvt && !user.hasGrvtCreds) {
    return <Navigate to="/onboarding/grvt" replace />;
  }

  return <>{children}</>;
}
