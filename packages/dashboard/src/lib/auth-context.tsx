// Auth context — manages JWT token, user profile, and auth flows.
//
// Token lives in localStorage('grvt-grid-token'). On mount, if a token
// exists, we call GET /auth/me to validate it. A 401 clears the token
// and redirects to /login. The api-client reads the token from
// localStorage on every request so we don't need a global ref.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setAuthToken, clearAuthToken } from './api-client';

const TOKEN_KEY = 'grvt-grid-token';

export interface AuthUser {
  id: number;
  email: string;
  isAdmin: boolean;
  hasGrvtCreds: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AuthCtx {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem(TOKEN_KEY)
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(!!token); // loading if we have a token to validate

  const saveToken = useCallback((t: string) => {
    localStorage.setItem(TOKEN_KEY, t);
    setAuthToken(t);
    setToken(t);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    clearAuthToken();
    setToken(null);
    setUser(null);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const data = await api.getMe();
      setUser({
        id: data.id,
        email: data.email,
        isAdmin: data.isAdmin,
        hasGrvtCreds: data.hasGrvtCreds,
        createdAt: data.createdAt,
        lastLoginAt: data.lastLoginAt,
      });
    } catch {
      logout();
    }
  }, [logout]);

  // On mount: validate existing token
  useEffect(() => {
    if (token) {
      setAuthToken(token);
      refreshMe().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for 401 events dispatched by api-client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    saveToken(res.token);
    setUser({
      id: res.userId,
      email,
      isAdmin: res.isAdmin,
      hasGrvtCreds: res.hasGrvtCreds,
      createdAt: 0,
      lastLoginAt: null,
    });
  }, [saveToken]);

  const signup = useCallback(async (email: string, password: string) => {
    const res = await api.signup(email, password);
    saveToken(res.token);
    setUser({
      id: res.userId,
      email,
      isAdmin: res.isAdmin,
      hasGrvtCreds: false,
      createdAt: Date.now(),
      lastLoginAt: null,
    });
  }, [saveToken]);

  const value = useMemo<AuthCtx>(
    () => ({ user, token, loading, login, signup, logout, refreshMe }),
    [user, token, loading, login, signup, logout, refreshMe]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
