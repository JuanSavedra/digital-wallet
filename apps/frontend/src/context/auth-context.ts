import { createContext, useContext } from 'react';
import type { AuthSession } from '../api/types';
import type { AuthStatus } from '../lib/token-store';

export interface AuthContextValue {
  /** `unknown` enquanto o refresh de bootstrap não respondeu — telas
   * protegidas devem esperar em vez de redirecionar para /login. */
  status: AuthStatus;
  isAuthenticated: boolean;
  login: (session: AuthSession) => void;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth precisa ser usado dentro de um AuthProvider');
  }
  return context;
}
