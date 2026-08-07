import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Wallet } from '@prisma/client';
import { RedisService } from '../cache/redis.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { StatementEntry } from './dto/statement-entry';

const BALANCE_CACHE_TTL_SECONDS = 30;
const STATEMENT_CACHE_TTL_SECONDS = 60;
export const STATEMENT_PAGE_SIZE = 20;

const balanceCacheKey = (walletId: string) => `wallet:balance:${walletId}`;
const statementCacheKey = (walletId: string, page: number) =>
  `wallet:statement:${walletId}:page:${page}`;

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
  ) {}

  createForUser(userId: string): Promise<Wallet> {
    return this.prisma.wallet.create({ data: { userId, balance: 0n } });
  }

  findByUserId(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  findById(id: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { id } });
  }

  /** Permite transferir informando o e-mail do destinatário em vez de
   * decorar/copiar o UUID da carteira dele. */
  findByUserEmail(email: string): Promise<Wallet | null> {
    return this.prisma.wallet.findFirst({ where: { user: { email } } });
  }

  async assertOwnership(walletId: string, userId: string): Promise<Wallet> {
    const wallet = await this.findById(walletId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    if (wallet.userId !== userId) {
      throw new ForbiddenException('Você não tem acesso a esta carteira');
    }
    return wallet;
  }

  /**
   * Cache-aside: lê do Redis; em caso de miss, busca no Postgres e povoa
   * o cache com TTL de segurança (mesmo que a invalidação via evento
   * falhe por algum motivo, o cache nunca fica desatualizado por mais que
   * esse tempo).
   */
  async getCachedBalance(walletId: string): Promise<bigint> {
    const cacheKey = balanceCacheKey(walletId);
    const cached = await this.redisService.get(cacheKey);
    if (cached !== null) {
      this.metricsService.recordCacheHit('wallet_balance');
      return BigInt(cached);
    }
    this.metricsService.recordCacheMiss('wallet_balance');

    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    await this.redisService.set(
      cacheKey,
      wallet.balance.toString(),
      BALANCE_CACHE_TTL_SECONDS,
    );
    return wallet.balance;
  }

  /**
   * Extrato paginado (mais recente primeiro), mesclando o ledger de
   * transferências com os depósitos pagos. Cada fonte busca `skip +
   * pageSize` candidatos e a mescla é ordenada/paginada em memória — só a
   * página 1 é ativamente invalidada quando algo novo acontece (ver
   * `invalidateWalletCaches`), então essa aproximação é aceitável: páginas
   * mais fundo na paginação praticamente não mudam depois de escritas.
   */
  async getStatement(
    walletId: string,
    page: number,
  ): Promise<StatementEntry[]> {
    const cacheKey = statementCacheKey(walletId, page);
    const cached = await this.redisService.get(cacheKey);
    if (cached !== null) {
      this.metricsService.recordCacheHit('wallet_statement');
      return JSON.parse(cached) as StatementEntry[];
    }
    this.metricsService.recordCacheMiss('wallet_statement');

    const skip = (page - 1) * STATEMENT_PAGE_SIZE;
    const candidateLimit = skip + STATEMENT_PAGE_SIZE;

    const [ledgerEntries, deposits] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { walletId },
        orderBy: { createdAt: 'desc' },
        take: candidateLimit,
      }),
      this.prisma.walletDeposit.findMany({
        where: { walletId, status: 'PAID' },
        orderBy: { createdAt: 'desc' },
        take: candidateLimit,
      }),
    ]);

    const merged: StatementEntry[] = [
      ...ledgerEntries.map(
        (entry): StatementEntry => ({
          id: entry.id,
          source: 'transfer',
          transactionId: entry.transactionId,
          direction: entry.direction,
          amount: entry.amount.toString(),
          createdAt: entry.createdAt,
        }),
      ),
      ...deposits.map(
        (deposit): StatementEntry => ({
          id: deposit.id,
          source: 'deposit',
          transactionId: null,
          direction: 'CREDIT',
          amount: deposit.amount.toString(),
          createdAt: deposit.paidAt ?? deposit.createdAt,
        }),
      ),
    ]
      .sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf())
      .slice(skip, skip + STATEMENT_PAGE_SIZE);

    await this.redisService.set(
      cacheKey,
      JSON.stringify(merged),
      STATEMENT_CACHE_TTL_SECONDS,
    );
    return merged;
  }

  async invalidateWalletCaches(walletId: string): Promise<void> {
    await Promise.all([
      this.redisService.del(balanceCacheKey(walletId)),
      this.redisService.del(statementCacheKey(walletId, 1)),
    ]);
  }
}
