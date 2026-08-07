# 06 — Lock distribuído (Redis)

## O que o Escopo 6 pedia

Um lock distribuído por carteira, com granularidade `lock:wallet:{id}`, aquisição em ordem determinística para evitar deadlock, TTL curto com retry limitado, liberação garantida mesmo em caso de exceção, e mantendo o lock otimista do Escopo 5 como camada adicional (não substituída).

Ver primeiro a seção "Lock otimista vs. lock distribuído" em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md) para o raciocínio de por que as duas camadas coexistem.

## Como foi resolvido

Tudo em `RedisLockService` (`apps/backend/src/cache/redis-lock.service.ts`) — implementação própria, sem depender de uma lib como `redlock`. A decisão de não usar `redlock` está documentada no `TODO.md`: `redlock` foi desenhado para quórum entre **múltiplas instâncias** de Redis independentes; com um único Redis (o caso deste projeto), seria complexidade sem benefício real.

### Aquisição: `SET NX PX`, atômico por natureza

```ts
private async acquire(key: string, ttlMs: number, maxAttempts = 20, retryDelayMs = 50): Promise<string> {
  const token = randomUUID();
  const client = this.redisService.getClient();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.set(key, token, 'PX', ttlMs, 'NX');
    if (result === 'OK') return token;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new LockAcquisitionError(key);
}
```

`SET key value PX ttl NX` é um único comando Redis atômico: "define esta chave só se ela não existir, com este TTL". Não há como duas execuções concorrentes ambas "ganharem" o `SET NX` para a mesma chave — o próprio Redis, sendo single-threaded para execução de comandos, garante isso. O valor gravado não é um `true` genérico, é um **token aleatório** (`randomUUID()`) único por tentativa de aquisição — o motivo fica claro na liberação, abaixo.

Se a aquisição falhar (chave já existe = outra execução tem o lock), o código tenta de novo com backoff fixo: até 20 tentativas de 50ms, ~1s de espera máxima, antes de desistir e lançar `LockAcquisitionError`, que `TransactionsService` converte em 409 para o cliente.

### Liberação: só quem colocou o lock pode tirá-lo

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

Este script Lua roda atomicamente dentro do Redis (via `EVAL`) e resolve um problema real: sem ele, seria possível o processo A adquirir o lock, o TTL expirar sozinho (ex.: A ficou lento demais), o processo B adquirir o mesmo lock enquanto A ainda pensa que é dono dele, e então A terminar seu trabalho e chamar "libera o lock" — liberando, na verdade, o lock que já pertence a B. O `GET` + `DEL` condicional, comparando contra o token específico que A recebeu na aquisição, impede exatamente isso: A só consegue apagar a chave se o valor nela ainda for o token que A colocou lá.

### Ordem determinística — por que evita deadlock

```ts
async withLock<T>(rawKeys: string[], ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(rawKeys)].sort();   // ordem alfabética, sempre
  const acquired: { key: string; token: string }[] = [];
  try {
    for (const key of keys) {
      acquired.push({ key, token: await this.acquire(key, ttlMs) });
    }
    return await fn();
  } finally {
    for (const { key, token } of acquired.reverse()) {
      await this.release(key, token);
    }
  }
}
```

O cenário que isso previne: uma transferência A→B pede os locks `[wallet:A, wallet:B]`, e simultaneamente uma transferência B→A pede `[wallet:B, wallet:A]`. Sem ordenação, é possível a primeira travar `wallet:A` enquanto espera `wallet:B`, e a segunda travar `wallet:B` enquanto espera `wallet:A` — as duas esperando para sempre uma pela outra, um deadlock clássico. Ordenando as chaves alfabeticamente antes de adquirir (`[...new Set(rawKeys)].sort()`), as duas transferências concorrentes tentam adquirir na **mesma ordem** (`wallet:A` primeiro, depois `wallet:B`, não importa qual carteira é origem ou destino) — uma delas sempre consegue os dois locks primeiro, e a outra simplesmente espera na fila do primeiro lock, sem nunca formar um ciclo de espera.

`[...new Set(rawKeys)]` antes do `sort` também cobre um caso degenerado que o `TransactionsService` não tem hoje (auto-transferência já é rejeitada antes de chegar aqui), mas que a função em si precisa tratar corretamente: chaves duplicadas na lista não devem gerar tentativa de adquirir o mesmo lock duas vezes.

### Liberação garantida mesmo com exceção

O `try/finally` em `withLock` garante que a liberação roda mesmo se `fn()` (a operação de negócio dentro do lock, no caso a transferência inteira) lançar uma exceção. Sem isso, uma falha de negócio (ex.: saldo insuficiente, que já lança dentro da `$transaction`) deixaria o lock preso até o TTL expirar sozinho — degradando a experiência de qualquer outra operação concorrente na mesma carteira, sem necessidade.

## Como se conecta com o resto do sistema

- `TransactionsService.doTransfer` (Escopo 5) é o único chamador de `withLock` hoje, com `WALLET_LOCK_TTL_MS = 5_000` e as chaves `lock:wallet:{originId}`/`lock:wallet:{destinationId}`.
- O lock reduz a taxa de conflito de `version` (Escopo 5) sob concorrência real, mas não o substitui — ele é sobre **latência e determinismo de resultado**, o `version` é sobre **correção garantida**. Ver a tabela comparativa em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md).
- `RedisService` (usado aqui via `getClient()`) é `@Global()` e compartilhado com a allowlist de refresh token (Escopo 3), o cache de saldo/extrato (Escopo 9) e a dedupe do consumidor RabbitMQ (Escopo 8) — mesmo Redis, prefixos de chave distintos (`lock:wallet:`, `auth:refresh:`, `wallet:balance:`/`wallet:statement:`, `processed:event:`).

## Como validar

```bash
cd apps/backend
npm run test                    # unitário: withLock mockado, incluindo o caso de exceção no meio
docker compose up -d redis
npm run test:e2e -- transfer    # e2e com Redis real embutido no teste de concorrência
```

Validação manual: disparar requisições `curl` em paralelo contra a mesma carteira e, depois, checar via `redis-cli KEYS 'lock:wallet:*'` que nenhuma chave de lock ficou órfã.
