/**
 * Só o access token volta no corpo. O refresh token não passa mais pelo
 * JavaScript: ele vive num cookie httpOnly setado pelo backend (Escopo 13).
 */
export interface AuthSession {
  accessToken: string;
}

export interface RegisteredUser {
  id: string;
  email: string;
}

export interface Wallet {
  id: string;
  userId: string;
  balance: string;
  createdAt: string;
  updatedAt: string;
}

export type LedgerDirection = 'DEBIT' | 'CREDIT';
export type StatementEntrySource = 'transfer' | 'deposit';

export interface StatementEntry {
  id: string;
  source: StatementEntrySource;
  transactionId: string | null;
  depositId: string | null;
  direction: LedgerDirection;
  amount: string;
  createdAt: string;
}

export interface StatementResponse {
  page: number;
  entries: StatementEntry[];
  hasMore: boolean;
}

export type DepositStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';

export interface Deposit {
  id: string;
  amount: string;
  status: DepositStatus;
  checkoutUrl: string;
  createdAt: string;
  paidAt: string | null;
}

export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface Transaction {
  id: string;
  originWalletId: string;
  destinationWalletId: string;
  amount: string;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
}
