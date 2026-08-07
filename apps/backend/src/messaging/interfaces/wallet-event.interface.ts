export interface WalletEventMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}
