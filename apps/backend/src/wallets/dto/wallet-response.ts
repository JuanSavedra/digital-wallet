import { Wallet } from '@prisma/client';

export function toWalletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    userId: wallet.userId,
    balance: wallet.balance.toString(),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
