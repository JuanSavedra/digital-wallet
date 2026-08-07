export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
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

export interface StatementEntry {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  createdAt: string;
}

export interface StatementResponse {
  page: number;
  entries: StatementEntry[];
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
