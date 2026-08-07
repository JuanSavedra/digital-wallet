import { LockAcquisitionError, RedisLockService } from './redis-lock.service';
import { RedisService } from './redis.service';

describe('RedisLockService', () => {
  let redisLockService: RedisLockService;
  let client: { set: jest.Mock; eval: jest.Mock };
  let redisService: jest.Mocked<RedisService>;

  beforeEach(() => {
    client = { set: jest.fn(), eval: jest.fn() };
    redisService = {
      getClient: jest.fn().mockReturnValue(client),
    } as unknown as jest.Mocked<RedisService>;
    redisLockService = new RedisLockService(redisService);
  });

  it('acquires the lock, runs the callback, and releases it afterwards', async () => {
    client.set.mockResolvedValue('OK');
    client.eval.mockResolvedValue(1);

    const result = await redisLockService.withLock(
      ['lock:wallet:a'],
      1_000,
      () => Promise.resolve('done'),
    );

    expect(result).toBe('done');
    expect(client.set).toHaveBeenCalledWith(
      'lock:wallet:a',
      expect.any(String),
      'PX',
      1_000,
      'NX',
    );
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it('acquires locks in deterministic (sorted) order regardless of input order', async () => {
    client.set.mockResolvedValue('OK');
    client.eval.mockResolvedValue(1);

    await redisLockService.withLock(
      ['lock:wallet:z', 'lock:wallet:a'],
      1_000,
      () => Promise.resolve(undefined),
    );

    const order = client.set.mock.calls.map((call: unknown[]) => call[0]);
    expect(order).toEqual(['lock:wallet:a', 'lock:wallet:z']);
  });

  it('releases already-acquired locks even when the callback throws', async () => {
    client.set.mockResolvedValue('OK');
    client.eval.mockResolvedValue(1);
    const error = new Error('falha no callback');

    await expect(
      redisLockService.withLock(['lock:wallet:a'], 1_000, () => {
        throw error;
      }),
    ).rejects.toThrow(error);

    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it('throws LockAcquisitionError after exhausting retries without acquiring', async () => {
    client.set.mockResolvedValue(null);

    await expect(
      redisLockService.withLock(['lock:wallet:a'], 1_000, () =>
        Promise.resolve('never'),
      ),
    ).rejects.toThrow(LockAcquisitionError);
  }, 10_000);

  it('does not release a lock it never acquired when a later key in the batch fails', async () => {
    client.set
      .mockResolvedValueOnce('OK') // lock:wallet:a acquired
      .mockResolvedValue(null); // lock:wallet:b never acquired

    await expect(
      redisLockService.withLock(['lock:wallet:a', 'lock:wallet:b'], 1_000, () =>
        Promise.resolve('never'),
      ),
    ).rejects.toThrow(LockAcquisitionError);

    // Só o lock "a", que foi de fato adquirido, deve ser liberado.
    expect(client.eval).toHaveBeenCalledTimes(1);
  }, 10_000);
});
