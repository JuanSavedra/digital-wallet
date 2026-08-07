import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { TransactionsModule } from './transactions/transactions.module';
import { LedgerModule } from './ledger/ledger.module';
import { OutboxModule } from './outbox/outbox.module';
import { CacheModule } from './cache/cache.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
      // Escotilha só para os testes e2e, que registram dezenas de usuários e
      // criam depósitos em sequência — com os limites reais ligados, as
      // suítes falhariam por 429 em vez de pelo que estão testando. Nunca é
      // ligada em runtime real: o `.env.example` não traz a variável e o
      // padrão (ausente) mantém o rate limit ativo.
      skipIf: () => process.env.RATE_LIMIT_DISABLED === 'true',
    }),
    PrismaModule,
    CacheModule,
    MetricsModule,
    AuthModule,
    UsersModule,
    WalletsModule,
    TransactionsModule,
    LedgerModule,
    OutboxModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
