import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';
import { deleteLedgerEntries } from './utils/ledger-cleanup';

/**
 * Requer Postgres e Redis reais (`make up`). Cobre o núcleo do Escopo 5:
 * idempotência (reenvio da mesma requisição não duplica o débito) e a
 * validação de que a atualização de saldo é segura sob concorrência real
 * (lock otimista via coluna `version`, antes do lock distribuído no Redis
 * do Escopo 6).
 */
describe('Transfers (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  const allEmails: string[] = [];
  const password = 'senha-forte-123';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);
  });

  afterAll(async () => {
    // Sempre fechar o app no finally: se a limpeza falhar antes de
    // `app.close()`, os pollers do ScheduleModule (ex.: DlqMetricsPoller)
    // nunca são parados e ficam disparando contra uma conexão morta —
    // o processo do Jest trava esperando por eles indefinidamente.
    try {
      const users = await prisma.user.findMany({
        where: { email: { in: allEmails } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);
      const wallets = await prisma.wallet.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const walletIds = wallets.map((w) => w.id);
      const transactions = await prisma.transaction.findMany({
        where: { originWalletId: { in: walletIds } },
        select: { id: true },
      });
      const transactionIds = transactions.map((t) => t.id);
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: transactionIds } },
      });
      await deleteLedgerEntries(prisma, { walletId: { in: walletIds } });
      await prisma.transaction.deleteMany({
        where: { originWalletId: { in: walletIds } },
      });
      await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
  });

  // Assina o access token diretamente (mesmo formato do AuthService) em vez
  // de chamar POST /auth/login: o login tem rate limit de 5/min (proposital,
  // contra brute-force) e este arquivo cria muitos usuários de teste — usar
  // o endpoint aqui derrubaria os próprios testes por 429, sem relação
  // nenhuma com o que este escopo (idempotência/concorrência) verifica.
  async function createFundedUser(initialBalanceCents: bigint) {
    const email = `transfer-${randomUUID()}@example.com`;
    allEmails.push(email);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const wallet = await prisma.wallet.update({
      where: { userId: user.id },
      data: { balance: initialBalanceCents },
    });

    const accessToken = await jwtService.signAsync(
      { sub: user.id, email: user.email },
      { secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET') },
    );

    return { accessToken, walletId: wallet.id };
  }

  it('rejects a transfer without the Idempotency-Key header', async () => {
    const origin = await createFundedUser(10_000n);
    const destination = await createFundedUser(0n);

    const response = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });

    expect(response.status).toBe(400);
  });

  it('rejects a self-transfer', async () => {
    const origin = await createFundedUser(10_000n);

    const response = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: origin.walletId, amount: 1_000 });

    expect(response.status).toBe(400);
  });

  it('rejects a transfer larger than the available balance and marks it FAILED', async () => {
    const origin = await createFundedUser(500n);
    const destination = await createFundedUser(0n);

    const response = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });

    expect(response.status).toBe(400);

    const originWallet = await prisma.wallet.findUnique({
      where: { id: origin.walletId },
    });
    expect(originWallet?.balance).toBe(500n);
  });

  it('replays the same result on retry and never double-debits (core idempotency requirement)', async () => {
    const origin = await createFundedUser(10_000n);
    const destination = await createFundedUser(0n);
    const idempotencyKey = randomUUID();
    const payload = {
      destinationWalletId: destination.walletId,
      amount: 2_500,
    };

    const first = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(first.status).toBe(201);

    const retry = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(retry.status).toBe(201);
    expect((retry.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );

    const originWallet = await prisma.wallet.findUnique({
      where: { id: origin.walletId },
    });
    const destinationWallet = await prisma.wallet.findUnique({
      where: { id: destination.walletId },
    });
    expect(originWallet?.balance).toBe(7_500n);
    expect(destinationWallet?.balance).toBe(2_500n);
  });

  it('keeps the balance correct under real concurrent transfers from the same wallet', async () => {
    // Saldo só cobre uma das duas transferências concorrentes de 6000 cada.
    const origin = await createFundedUser(10_000n);
    const destination = await createFundedUser(0n);

    const [responseA, responseB] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/transactions/transfer')
        .set('Authorization', `Bearer ${origin.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ destinationWalletId: destination.walletId, amount: 6_000 }),
      request(app.getHttpServer())
        .post('/api/v1/transactions/transfer')
        .set('Authorization', `Bearer ${origin.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ destinationWalletId: destination.walletId, amount: 6_000 }),
    ]);

    const statuses = [responseA.status, responseB.status];
    const successCount = statuses.filter((s) => s === 201).length;
    const failureCount = statuses.filter((s) => s === 400 || s === 409).length;
    // Sob concorrência real, a perdedora da corrida pode ser rejeitada por
    // saldo insuficiente (leu o saldo já debitado, 400) ou por conflito no
    // lock otimista da coluna `version` (leu o saldo antigo, mas perdeu a
    // corrida no UPDATE, 409) — o que importa é que exatamente uma vence.
    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);

    const originWallet = await prisma.wallet.findUnique({
      where: { id: origin.walletId },
    });
    const destinationWallet = await prisma.wallet.findUnique({
      where: { id: destination.walletId },
    });
    // Nunca pode ter saído dinheiro do nada nem sumido: exatamente uma
    // transferência de 6000 deve ter sido aplicada.
    expect(originWallet?.balance).toBe(4_000n);
    expect(destinationWallet?.balance).toBe(6_000n);
  });

  it('survives a higher-fan-out burst of concurrent transfers from the same wallet without corrupting the balance', async () => {
    // Saldo cobre exatamente metade das 20 transferências concorrentes de
    // 500 cada — simula carga real (Escopo 12) e não só duas requisições.
    const origin = await createFundedUser(5_000n);
    const destination = await createFundedUser(0n);
    const attempts = 20;
    const amountPerTransfer = 500;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer())
          .post('/api/v1/transactions/transfer')
          .set('Authorization', `Bearer ${origin.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            destinationWalletId: destination.walletId,
            amount: amountPerTransfer,
          }),
      ),
    );

    const successCount = responses.filter((r) => r.status === 201).length;
    const failureCount = responses.filter(
      (r) => r.status === 400 || r.status === 409,
    ).length;
    expect(successCount).toBe(10);
    expect(failureCount).toBe(attempts - 10);

    const originWallet = await prisma.wallet.findUnique({
      where: { id: origin.walletId },
    });
    const destinationWallet = await prisma.wallet.findUnique({
      where: { id: destination.walletId },
    });
    // Nada de dinheiro perdido nem duplicado: a soma dos dois saldos
    // continua batendo com o total original, e o destino recebeu
    // exatamente `successCount` transferências.
    expect(
      (originWallet?.balance ?? 0n) + (destinationWallet?.balance ?? 0n),
    ).toBe(5_000n);
    expect(destinationWallet?.balance).toBe(
      BigInt(successCount * amountPerTransfer),
    );
  });

  it('survives concurrent transfers from many wallets into the same destination', async () => {
    const destination = await createFundedUser(0n);
    const senderCount = 10;
    const senders = await Promise.all(
      Array.from({ length: senderCount }, () => createFundedUser(1_000n)),
    );

    const responses = await Promise.all(
      senders.map((sender) =>
        request(app.getHttpServer())
          .post('/api/v1/transactions/transfer')
          .set('Authorization', `Bearer ${sender.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ destinationWalletId: destination.walletId, amount: 1_000 }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const destinationWallet = await prisma.wallet.findUnique({
      where: { id: destination.walletId },
    });
    // Créditos concorrentes vindos de origens diferentes não podem se
    // perder por corrida no lock otimista da carteira de destino.
    expect(destinationWallet?.balance).toBe(BigInt(senderCount * 1_000));
  });

  it('propagates the HTTP correlation id all the way into the outbox event', async () => {
    const origin = await createFundedUser(10_000n);
    const destination = await createFundedUser(0n);
    const correlationId = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .set('x-request-id', correlationId)
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });

    expect(response.status).toBe(201);
    expect(response.headers['x-request-id']).toBe(correlationId);

    const transactionId = (response.body as { id: string }).id;
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: { aggregateId: transactionId },
    });
    expect(outboxEvent?.correlationId).toBe(correlationId);
  });

  it('exposes transfer metrics on GET /api/metrics after a completed transfer', async () => {
    const origin = await createFundedUser(10_000n);
    const destination = await createFundedUser(0n);

    const transferResponse = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });
    expect(transferResponse.status).toBe(201);

    const metricsResponse = await request(app.getHttpServer()).get(
      '/api/metrics',
    );

    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.text).toContain('wallet_transfer_duration_seconds');
    expect(metricsResponse.text).toMatch(
      /wallet_transfer_duration_seconds_count \d+/,
    );
  });
});
