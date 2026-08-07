import { Wallet } from '@prisma/client';

export function toWalletResponse(wallet: Wallet, balanceOverride?: bigint) {
  return {
    id: wallet.id,
    userId: wallet.userId,
    balance: (balanceOverride ?? wallet.balance).toString(),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
