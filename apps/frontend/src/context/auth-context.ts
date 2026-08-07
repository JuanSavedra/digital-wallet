import { createContext, useContext } from 'react';
import type { AuthTokens } from '../api/types';

export interface AuthContextValue {
  isAuthenticated: boolean;
  login: (tokens: AuthTokens) => void;
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
