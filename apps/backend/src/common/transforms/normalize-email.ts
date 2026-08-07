import { Transform } from 'class-transformer';

/**
 * Normaliza o e-mail para minúsculas + sem espaços nas pontas.
 *
 * Sem isso, `Alice@example.com` e `alice@example.com` viram **duas contas
 * distintas** (a coluna é `@unique`, mas o Postgres compara texto de forma
 * sensível a caixa). Numa carteira isso é explorável: basta cadastrar a
 * variação em outra caixa do e-mail de alguém conhecido para que
 * `GET /wallets/lookup?email=` devolva a carteira errada e o remetente
 * transfira dinheiro para o impostor achando que acertou o destinatário.
 *
 * Aplicado em todos os pontos de entrada de e-mail (registro, login e
 * lookup) para que a normalização seja consistente entre gravação e leitura.
 */
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}
