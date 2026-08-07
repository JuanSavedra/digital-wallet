/**
 * Armazenamento do access token **apenas em memória**.
 *
 * Antes do Escopo 13 o par inteiro (access + refresh) vivia em
 * `localStorage`: qualquer XSS lia os dois com uma linha de JavaScript e
 * exfiltrava uma sessão que sobrevivia a fechar o navegador. Agora:
 *
 * - o access token fica nesta variável de módulo — some ao recarregar a
 *   página e não é legível por nada fora do bundle;
 * - o refresh token não passa mais pelo JavaScript: ele viaja num cookie
 *   `httpOnly` + `SameSite=Strict` que só o backend lê/escreve (ver
 *   `AuthController` e `refresh-cookie.ts`).
 *
 * A sessão continua sobrevivendo ao F5 porque o `AuthProvider` chama
 * `/auth/refresh` na inicialização — o cookie ainda está lá, mesmo sem
 * nenhum token no `localStorage`.
 */

const listeners = new Set<() => void>();

/** Estado inicial `unknown`: ainda não sabemos se existe um cookie de
 * refresh válido. É o que impede o `ProtectedRoute` de chutar "não
 * autenticado" e redirecionar para /login antes do refresh de bootstrap. */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

let accessToken: string | null = null;
let status: AuthStatus = 'unknown';

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAuthStatus(): AuthStatus {
  return status;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  status = token ? 'authenticated' : 'anonymous';
  listeners.forEach((listener) => listener());
}

/** Marca o bootstrap como concluído sem sessão (nenhum cookie válido). */
export function markAnonymous(): void {
  accessToken = null;
  status = 'anonymous';
  listeners.forEach((listener) => listener());
}

export function subscribeToAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Só para os testes: devolve o módulo ao estado de app recém-carregado. */
export function resetAuthStoreForTests(): void {
  accessToken = null;
  status = 'unknown';
  listeners.forEach((listener) => listener());
}
