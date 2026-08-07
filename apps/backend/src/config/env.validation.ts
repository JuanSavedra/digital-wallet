import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().uri().required(),

  REDIS_URL: Joi.string().uri().required(),

  RABBITMQ_URL: Joi.string().uri().required(),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  // Projeto nunca sai do dev mode do AbacatePay (ver TODO.md) — sem chave
  // real ainda, mas o schema já valida o formato esperado.
  ABACATEPAY_API_KEY: Joi.string().required(),
  ABACATEPAY_BASE_URL: Joi.string()
    .uri()
    .default('https://api.abacatepay.com/v2'),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:5173'),
});
