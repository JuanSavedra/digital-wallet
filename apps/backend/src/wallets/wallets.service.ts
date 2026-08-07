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
   * Extrato paginado (mais recente primeiro), lido direto do livro-razão.
   *
   * Antes do Escopo 13 isso mesclava duas fontes (ledger + depósitos pagos)
   * em memória, porque depósitos não geravam lançamento. Agora que geram
   * (`DepositsService.confirmPaid`), o razão é a única fonte — o que além de
   * simplificar corrige a paginação (o `skip`/`take` acontece no Postgres) e
   * elimina o `take: skip + pageSize` que fazia páginas altas varrerem a
   * tabela inteira.
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

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      // Desempate por id mantém a ordem estável entre páginas quando dois
      // lançamentos compartilham o mesmo `createdAt` — o caso normal, já
      // que débito e crédito de uma transferência nascem juntos.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * STATEMENT_PAGE_SIZE,
      take: STATEMENT_PAGE_SIZE,
    });

    const statement: StatementEntry[] = entries.map((entry) => ({
      id: entry.id,
      source: entry.depositId ? 'deposit' : 'transfer',
      transactionId: entry.transactionId,
      depositId: entry.depositId,
      direction: entry.direction,
      amount: entry.amount.toString(),
      createdAt: entry.createdAt,
    }));

    await this.redisService.set(
      cacheKey,
      JSON.stringify(statement),
      STATEMENT_CACHE_TTL_SECONDS,
    );
    return statement;
  }

  async invalidateWalletCaches(walletId: string): Promise<void> {
    await Promise.all([
      this.redisService.del(balanceCacheKey(walletId)),
      this.redisService.del(statementCacheKey(walletId, 1)),
    ]);
  }
}
