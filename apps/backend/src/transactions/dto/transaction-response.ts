import { Transaction } from '@prisma/client';

export function toTransactionResponse(transaction: Transaction) {
  return {
    id: transaction.id,
    originWalletId: transaction.originWalletId,
    destinationWalletId: transaction.destinationWalletId,
    amount: transaction.amount.toString(),
    status: transaction.status,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}
