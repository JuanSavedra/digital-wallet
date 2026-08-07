import * as Joi from 'joi';

// Valores de placeholder que vêm no .env.example. Servem para dev, mas
// subir com eles em produção é o equivalente a não ter segredo nenhum —
// qualquer um que leia o repositório assina um JWT válido.
export const PLACEHOLDER_SECRETS = [
  'change-me-access',
  'change-me-refresh',
  'change-me-abacatepay-dev-key',
];

/**
 * Em produção um segredo fraco é falha de boot, não aviso: com
 * `change-me-access` no repositório, qualquer um assina um JWT válido e se
 * autentica como qualquer usuário. Fora de produção a regra é relaxada de
 * propósito para não quebrar o setup local de quem copiou o .env.example —
 * mas o boot registra um aviso alto (ver `warnOnWeakSecrets`).
 */
const secretString = Joi.string()
  .min(16)
  .required()
  .when('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .min(32)
      .invalid(...PLACEHOLDER_SECRETS)
      .messages({
        'any.invalid':
          'segredo de placeholder do .env.example — em produção gere um valor real (ex.: `openssl rand -hex 32`)',
        'string.min':
          'em produção o segredo precisa ter no mínimo 32 caracteres',
      }),
  });

/** Segredo considerado fraco: curto demais ou o placeholder do exemplo. */
export function isWeakSecret(value: string | undefined): boolean {
  return !value || value.length < 32 || PLACEHOLDER_SECRETS.includes(value);
}

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().uri().required(),

  REDIS_URL: Joi.string().uri().required(),

  RABBITMQ_URL: Joi.string().uri().required(),

  JWT_ACCESS_SECRET: secretString,
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: secretString,
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  // Projeto nunca sai do dev mode do AbacatePay (ver TODO.md) — sem chave
  // real ainda, mas o schema já valida o formato esperado.
  ABACATEPAY_API_KEY: Joi.string().required(),
  ABACATEPAY_BASE_URL: Joi.string()
    .uri()
    .default('https://api.abacatepay.com/v2'),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:5173'),

  // --- Segurança (Escopo 13) ---

  // Origens permitidas no CORS, separadas por vírgula. Com credenciais
  // habilitadas (cookie do refresh token) não é possível responder
  // `Access-Control-Allow-Origin: *` — a lista precisa ser explícita.
  // Vazio = usa FRONTEND_URL.
  CORS_ORIGINS: Joi.string().allow('').default(''),

  // `strict` bloqueia o envio do cookie em qualquer navegação cross-site,
  // que é a defesa de CSRF do endpoint de refresh. Só troque para `none`
  // (que exige HTTPS) se o frontend for servido de um site diferente do
  // registrable domain da API.
  REFRESH_COOKIE_SAMESITE: Joi.string()
    .valid('strict', 'lax', 'none')
    .default('strict'),
  // Força `Secure` no cookie mesmo fora de produção (útil atrás de um
  // proxy TLS em homologação).
  REFRESH_COOKIE_SECURE: Joi.boolean().default(false),

  // E-mails autorizados nas rotas /admin (DLQ). Vazio = ninguém entra,
  // que é o padrão seguro: antes disso qualquer usuário logado podia
  // drenar e reprocessar a DLQ.
  ADMIN_EMAILS: Joi.string().allow('').default(''),

  // Bearer token exigido em GET /api/metrics. Vazio = endpoint aberto
  // (aceitável só quando ele não está exposto para fora da rede interna).
  METRICS_TOKEN: Joi.string().allow('').default(''),

  // Swagger expõe o mapa completo da API; por padrão fica fora de produção.
  SWAGGER_ENABLED: Joi.boolean().default(process.env.NODE_ENV !== 'production'),
});
