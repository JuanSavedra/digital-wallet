import { LedgerDirection } from '@prisma/client';

export interface StatementEntry {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  createdAt: Date;
}
