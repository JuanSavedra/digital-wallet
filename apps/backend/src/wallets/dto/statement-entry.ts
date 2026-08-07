import { LedgerDirection } from '@prisma/client';

export type StatementEntrySource = 'transfer' | 'deposit';

export interface StatementEntry {
  id: string;
  /** Derivado de qual origem o lançamento aponta — exatamente uma das duas
   * está preenchida (garantido por CHECK no banco). */
  source: StatementEntrySource;
  transactionId: string | null;
  depositId: string | null;
  direction: LedgerDirection;
  amount: string;
  createdAt: Date;
}
