import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './redis.service';

// Só libera a chave se o valor ainda for o token de quem a criou — evita
// que o processo A libere um lock que já expirou e foi adquirido pelo
// processo B nesse meio-tempo.
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class LockAcquisitionError extends Error {
  constructor(key: string) {
    super(`Não foi possível adquirir o lock para "${key}"`);
  }
}

@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Adquire o lock de todas as chaves informadas, em ordem determinística
   * (alfabética), executa `fn` e garante a liberação de todos os locks em
   * ordem inversa mesmo se `fn` lançar. Ordenar as chaves é o que evita
   * deadlock quando duas requisições concorrentes mexem nos mesmos dois
   * recursos em ordens opostas (ex.: transferência A→B ao mesmo tempo que
   * B→A).
   */
  async withLock<T>(
    rawKeys: string[],
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(rawKeys)].sort();
    const acquired: { key: string; token: string }[] = [];

    try {
      for (const key of keys) {
        const token = await this.acquire(key, ttlMs);
        acquired.push({ key, token });
      }
      return await fn();
    } finally {
      for (const { key, token } of acquired.reverse()) {
        await this.release(key, token);
      }
    }
  }

  private async acquire(
    key: string,
    ttlMs: number,
    maxAttempts = 20,
    retryDelayMs = 50,
  ): Promise<string> {
    const token = randomUUID();
    const client = this.redisService.getClient();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await client.set(key, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return token;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    this.logger.warn(`Timeout adquirindo lock: ${key}`);
    throw new LockAcquisitionError(key);
  }

  private async release(key: string, token: string): Promise<void> {
    const client = this.redisService.getClient();
    await client.eval(UNLOCK_SCRIPT, 1, key, token);
  }
}
