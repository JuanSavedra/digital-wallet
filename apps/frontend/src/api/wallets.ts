import { api } from '../lib/api-client';
import type { StatementResponse, Wallet } from './types';

export async function getMyWallet(): Promise<Wallet> {
  const { data } = await api.get<Wallet>('/wallets/me');
  return data;
}

export async function getMyStatement(page = 1): Promise<StatementResponse> {
  const { data } = await api.get<StatementResponse>('/wallets/me/statement', {
    params: { page },
  });
  return data;
}

export async function lookupWalletByEmail(email: string): Promise<string> {
  const { data } = await api.get<{ walletId: string }>('/wallets/lookup', {
    params: { email },
  });
  return data.walletId;
}
