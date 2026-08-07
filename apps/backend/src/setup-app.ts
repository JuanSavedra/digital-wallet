import {
  INestApplication,
  Logger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { isWeakSecret } from './config/env.validation';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

/**
 * Origens autorizadas no CORS. Com credenciais habilitadas (o refresh token
 * viaja num cookie httpOnly) o navegador recusa `Access-Control-Allow-Origin:
 * *` — a lista precisa ser explícita, o que também deixa de expor a API a
 * chamadas de qualquer site.
 */
export function resolveCorsOrigins(configService: ConfigService): string[] {
  const configured = configService
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }
  return [configService.get<string>('FRONTEND_URL', 'http://localhost:5173')];
}

/**
 * Shared between main.ts (real bootstrap) and e2e tests, so both run
 * against the exact same prefix/versioning/pipes/filters configuration.
 */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Cabeçalhos de segurança. `contentSecurityPolicy` fica desligado aqui
  // porque esta app só responde JSON (a CSP que importa é a do nginx que
  // serve o frontend) e a default do helmet quebraria o Swagger UI.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Necessário para ler o refresh token do cookie httpOnly (ver AuthController).
  app.use(cookieParser());

  // Frontend roda em outra origem/porta (Vite dev server ou nginx no
  // Docker) — sem isso o navegador bloqueia as chamadas por CORS.
  app.enableCors({
    origin: resolveCorsOrigins(configService),
    credentials: true,
    // O frontend precisa conseguir ler o correlation id nas respostas.
    exposedHeaders: ['x-request-id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Sem isto, o corpo rejeitado volta ecoado na resposta de erro do
      // class-validator — inclusive campos como `password`.
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  warnOnWeakSecrets(configService);
}

/**
 * Fora de produção o schema aceita segredos fracos para não quebrar o setup
 * local, mas o boot precisa dizer isso em voz alta — senão o `.env.example`
 * vira credencial de verdade sem ninguém perceber.
 */
function warnOnWeakSecrets(configService: ConfigService): void {
  const weak = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].filter((name) =>
    isWeakSecret(configService.get<string>(name)),
  );

  if (weak.length > 0) {
    new Logger('Security').warn(
      `Segredos fracos ou de placeholder em uso (${weak.join(', ')}). ` +
        'Aceitável apenas fora de produção — gere valores reais com `openssl rand -hex 32`.',
    );
  }
}
