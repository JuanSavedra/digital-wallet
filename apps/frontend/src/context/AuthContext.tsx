import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { logoutUser } from '../api/auth';
import { bootstrapSession } from '../lib/api-client';
import {
  getAuthStatus,
  markAnonymous,
  setAccessToken,
  subscribeToAuth,
} from '../lib/token-store';
import type { AuthSession } from '../api/types';
import { AuthContext } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useSyncExternalStore(subscribeToAuth, getAuthStatus);

  // O access token vive só em memória, então todo carregamento da página
  // começa sem sessão. Quem sabe se ela ainda existe é o cookie httpOnly de
  // refresh — este efeito troca esse cookie por um access token novo.
  useEffect(() => {
    if (getAuthStatus() === 'unknown') {
      void bootstrapSession();
    }
  }, []);

  const login = useCallback((session: AuthSession) => {
    setAccessToken(session.accessToken);
  }, []);

  const logout = useCallback(async () => {
    markAnonymous();
    try {
      // Revoga o jti no Redis e limpa o cookie httpOnly do lado do servidor
      // — sem isso o refresh token continuaria válido no navegador.
      await logoutUser();
    } catch {
      // Já limpamos o estado local; falha ao revogar no servidor não
      // deve travar o usuário na tela de logout.
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        isAuthenticated: status === 'authenticated',
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
