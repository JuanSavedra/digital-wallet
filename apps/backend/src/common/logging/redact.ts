export const REDACTED = '[REDACTED]';

/**
 * Nomes de campo que nunca podem aparecer em log. A comparação é por
 * *substring* em minúsculas, então `refreshToken`, `x-api-key` e
 * `user_password_hash` são todos pegos pelas entradas abaixo.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'senha',
  'passwordhash',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'credential',
  'idempotency-key',
  'pix',
  'cpf',
  'cardnumber',
  'cvv',
];

/**
 * Padrões que vazam mesmo quando o segredo está embutido numa string livre
 * (mensagem de erro, URL de conexão, header serializado) e portanto não têm
 * um "nome de campo" para casar.
 */
const SENSITIVE_VALUE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // JWT (três segmentos base64url separados por ponto).
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: REDACTED,
  },
  // "Bearer <algo>" em qualquer texto livre.
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  // Credenciais embutidas em URLs (postgres://user:senha@host, amqp://...).
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi,
    replacement: `$1:${REDACTED}@`,
  },
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function redactString(value: string): string {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (acc, { pattern, replacement }) => acc.replace(pattern, replacement),
    value,
  );
}

/**
 * Remove dados sensíveis antes de qualquer coisa chegar ao stdout/stderr.
 * Funciona em dois níveis: mascara valores de chaves conhecidamente
 * sensíveis e varre as strings restantes atrás de segredos embutidos.
 *
 * Referências circulares viram `[Circular]` em vez de estourar o
 * `JSON.stringify` — um log nunca deve derrubar o processo que ele observa.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redact(item, seen),
    ]),
  );
}
