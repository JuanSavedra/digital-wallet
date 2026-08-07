import { api } from '../lib/api-client';
import type { Transaction } from './types';

export async function transfer(
  destinationWalletId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<Transaction> {
  const { data } = await api.post<Transaction>(
    '/transactions/transfer',
    { destinationWalletId, amount: amountCents },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
  return data;
}

export async function getTransaction(id: string): Promise<Transaction> {
  const { data } = await api.get<Transaction>(`/transactions/${id}`);
  return data;
}
