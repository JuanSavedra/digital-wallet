import { WalletsService } from '../wallets/wallets.service';
import { TransactionEventsHandler } from './transaction-events.handler';

describe('TransactionEventsHandler', () => {
  let handler: TransactionEventsHandler;
  let walletsService: jest.Mocked<WalletsService>;

  beforeEach(() => {
    walletsService = {
      invalidateWalletCaches: jest.fn(),
    } as unknown as jest.Mocked<WalletsService>;
    handler = new TransactionEventsHandler(walletsService);
  });

  it('invalidates the cache for both wallets on transaction.completed', async () => {
    await handler.handle({
      id: 'evt-1',
      aggregateId: 'tx-1',
      eventType: 'transaction.completed',
      payload: {
        transactionId: 'tx-1',
        originWalletId: 'wallet-a',
        destinationWalletId: 'wallet-b',
        amount: '1000',
        status: 'COMPLETED',
      },
    });

    expect(walletsService.invalidateWalletCaches).toHaveBeenCalledWith(
      'wallet-a',
    );
    expect(walletsService.invalidateWalletCaches).toHaveBeenCalledWith(
      'wallet-b',
    );
  });

  it('does nothing for event types it does not recognize', async () => {
    await handler.handle({
      id: 'evt-1',
      aggregateId: 'tx-1',
      eventType: 'something.else',
      payload: {},
    });

    expect(walletsService.invalidateWalletCaches).not.toHaveBeenCalled();
  });
});
