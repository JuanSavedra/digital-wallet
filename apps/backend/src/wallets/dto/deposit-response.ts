import { WalletDeposit } from '@prisma/client';

export function toDepositResponse(deposit: WalletDeposit) {
  return {
    id: deposit.id,
    amount: deposit.amount.toString(),
    status: deposit.status,
    checkoutUrl: deposit.checkoutUrl,
    createdAt: deposit.createdAt,
    paidAt: deposit.paidAt,
  };
}
