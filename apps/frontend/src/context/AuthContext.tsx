import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { logoutUser } from '../api/auth';
import { getTokens, setTokens, subscribeToTokens } from '../lib/token-store';
import type { AuthTokens } from '../api/types';
import { AuthContext } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const tokens = useSyncExternalStore(subscribeToTokens, getTokens);

  const login = useCallback((newTokens: AuthTokens) => {
    setTokens(newTokens);
  }, []);

  const logout = useCallback(async () => {
    const current = getTokens();
    setTokens(null);
    if (current?.refreshToken) {
      try {
        await logoutUser(current.refreshToken);
      } catch {
        // Já limpamos o estado local; falha ao revogar no servidor não
        // deve travar o usuário na tela de logout.
      }
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated: tokens !== null, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
