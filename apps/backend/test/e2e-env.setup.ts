// Garante que os testes e2e não dependam do .env local do desenvolvedor:
// valores fixos e herméticos, aplicados antes do AppModule (e do
// ConfigModule/Joi) serem carregados por cada arquivo de teste.
process.env.DATABASE_URL ??=
  'postgresql://wallet:wallet@localhost:5432/wallet_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RABBITMQ_URL ??= 'amqp://wallet:wallet@localhost:5672';
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret';
