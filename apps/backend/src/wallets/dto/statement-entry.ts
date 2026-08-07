import { LedgerDirection } from '@prisma/client';

export type StatementEntrySource = 'transfer' | 'deposit';

export interface StatementEntry {
  id: string;
  source: StatementEntrySource;
  transactionId: string | null;
  direction: LedgerDirection;
  amount: string;
  createdAt: Date;
}
