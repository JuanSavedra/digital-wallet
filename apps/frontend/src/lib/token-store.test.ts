import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAccessToken,
  getAuthStatus,
  markAnonymous,
  resetAuthStoreForTests,
  setAccessToken,
  subscribeToAuth,
} from './token-store';

describe('token-store', () => {
  beforeEach(() => {
    resetAuthStoreForTests();
    localStorage.clear();
  });

  it('nunca escreve token no localStorage', () => {
    setAccessToken('access-token-123');

    // O ponto central do Escopo 13: antes, o par inteiro (access + refresh)
    // ficava em localStorage e um XSS levava a sessão persistida embora.
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify(localStorage)).not.toContain('access-token-123');
  });

  it('mantém o access token apenas em memória', () => {
    setAccessToken('access-token-123');

    expect(getAccessToken()).toBe('access-token-123');
    expect(getAuthStatus()).toBe('authenticated');
  });

  it('começa em "unknown" para não expulsar o usuário antes do refresh de bootstrap', () => {
    // Se o estado inicial fosse "anonymous", todo F5 redirecionaria para
    // /login antes de o cookie httpOnly ter chance de restaurar a sessão.
    expect(getAuthStatus()).toBe('unknown');
    expect(getAccessToken()).toBeNull();
  });

  it('marca "anonymous" quando o bootstrap falha', () => {
    markAnonymous();

    expect(getAuthStatus()).toBe('anonymous');
    expect(getAccessToken()).toBeNull();
  });

  it('notifica os inscritos a cada mudança e permite cancelar a inscrição', () => {
    let calls = 0;
    const unsubscribe = subscribeToAuth(() => {
      calls += 1;
    });

    setAccessToken('a');
    markAnonymous();
    expect(calls).toBe(2);

    unsubscribe();
    setAccessToken('b');
    expect(calls).toBe(2);
  });
});
