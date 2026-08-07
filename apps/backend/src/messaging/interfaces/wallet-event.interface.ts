export interface WalletEventMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface TransactionCompletedPayload {
  transactionId: string;
  originWalletId: string;
  destinationWalletId: string;
  amount: string;
  status: string;
}
