import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://wallet:wallet@localhost:5432/wallet',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://wallet:wallet@localhost:5672',
    JWT_ACCESS_SECRET: 'a'.repeat(16),
    JWT_REFRESH_SECRET: 'b'.repeat(16),
    ABACATEPAY_API_KEY: 'test-key',
  };

  interface ValidatedEnv {
    NODE_ENV: string;
    PORT: number;
    JWT_ACCESS_EXPIRES_IN: string;
    JWT_REFRESH_EXPIRES_IN: string;
  }

  it('accepts a valid environment and fills in defaults', () => {
    const { error, value } = envValidationSchema.validate(validEnv, {
      abortEarly: false,
    }) as { error?: Error; value: ValidatedEnv };

    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe('development');
    expect(value.PORT).toBe(3000);
    expect(value.JWT_ACCESS_EXPIRES_IN).toBe('15m');
    expect(value.JWT_REFRESH_EXPIRES_IN).toBe('7d');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'RABBITMQ_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'ABACATEPAY_API_KEY',
  ] as const)('rejects a missing required variable: %s', (key) => {
    const incompleteEnv = { ...validEnv };
    delete incompleteEnv[key];

    const { error } = envValidationSchema.validate(incompleteEnv, {
      abortEarly: false,
    });

    expect(error).toBeDefined();
    expect(error?.message).toContain(key);
  });

  it('rejects a JWT secret shorter than 16 characters', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      JWT_ACCESS_SECRET: 'too-short',
    });

    expect(error).toBeDefined();
  });

  describe('produção: segredos fracos derrubam o boot', () => {
    // Fora de produção a regra é frouxa de propósito (não quebrar o setup
    // local de quem copiou o .env.example), mas subir com o placeholder
    // valendo significa que qualquer um que leia o repositório assina um
    // JWT válido e se autentica como qualquer usuário.
    const prodEnv = {
      ...validEnv,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    };

    it('accepts strong secrets', () => {
      expect(envValidationSchema.validate(prodEnv).error).toBeUndefined();
    });

    it('rejects the placeholder from .env.example', () => {
      const { error } = envValidationSchema.validate({
        ...prodEnv,
        JWT_ACCESS_SECRET: 'change-me-access',
      });

      expect(error).toBeDefined();
    });

    it('rejects a secret shorter than 32 characters', () => {
      const { error } = envValidationSchema.validate({
        ...prodEnv,
        JWT_REFRESH_SECRET: 'b'.repeat(31),
      });

      expect(error).toBeDefined();
    });

    it('still accepts a 16-char secret outside production', () => {
      expect(
        envValidationSchema.validate({ ...validEnv, NODE_ENV: 'development' })
          .error,
      ).toBeUndefined();
    });
  });

  it('rejects an invalid NODE_ENV value', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'staging',
    });

    expect(error).toBeDefined();
  });
});
