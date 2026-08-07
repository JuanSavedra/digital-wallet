import { api } from '../lib/api-client';
import type { Deposit } from './types';

export async function createDeposit(amountCents: number): Promise<Deposit> {
  const { data } = await api.post<Deposit>('/wallets/me/deposits', {
    amount: amountCents,
  });
  return data;
}

export async function getDeposit(id: string): Promise<Deposit> {
  const { data } = await api.get<Deposit>(`/wallets/me/deposits/${id}`);
  return data;
}
