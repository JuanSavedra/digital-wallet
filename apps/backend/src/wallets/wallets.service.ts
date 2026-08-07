import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Wallet } from '@prisma/client';
import { RedisService } from '../cache/redis.service';
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
      return BigInt(cached);
    }

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
   * Extrato paginado (mais recente primeiro). O ledger é imutável, então
   * só a página 1 muda quando uma nova transação acontece — páginas mais
   * antigas nunca precisam de invalidação, só do TTL de segurança.
   */
  async getStatement(
    walletId: string,
    page: number,
  ): Promise<StatementEntry[]> {
    const cacheKey = statementCacheKey(walletId, page);
    const cached = await this.redisService.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached) as StatementEntry[];
    }

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * STATEMENT_PAGE_SIZE,
      take: STATEMENT_PAGE_SIZE,
    });
    const serialized: StatementEntry[] = entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount.toString(),
      createdAt: entry.createdAt,
    }));

    await this.redisService.set(
      cacheKey,
      JSON.stringify(serialized),
      STATEMENT_CACHE_TTL_SECONDS,
    );
    return serialized;
  }

  /**
   * Credita a carteira sem uma carteira de origem — não é uma
   * "transferência" (não usa idempotência/lock/outbox/ledger daquele
   * fluxo) porque não existe rail de captação externa real neste projeto
   * (PIX, cartão, etc. estão fora do escopo). Existe só pra dar saldo
   * inicial e permitir testar transferências de verdade. Um `UPDATE ...
   * SET balance = balance + amount` é atômico por natureza no Postgres —
   * não precisa do lock otimista usado nas transferências, que existe
   * especificamente para o padrão "ler saldo, decidir, escrever de volta".
   */
  async deposit(walletId: string, amountCents: bigint): Promise<Wallet> {
    const wallet = await this.prisma.wallet.update({
      where: { id: walletId },
      data: { balance: { increment: amountCents } },
    });
    await this.invalidateWalletCaches(walletId);
    return wallet;
  }

  async invalidateWalletCaches(walletId: string): Promise<void> {
    await Promise.all([
      this.redisService.del(balanceCacheKey(walletId)),
      this.redisService.del(statementCacheKey(walletId, 1)),
    ]);
  }
}
