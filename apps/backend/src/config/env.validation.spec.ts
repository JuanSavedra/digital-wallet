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

  it('rejects an invalid NODE_ENV value', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'staging',
    });

    expect(error).toBeDefined();
  });
});
