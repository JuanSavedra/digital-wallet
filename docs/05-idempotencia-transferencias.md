# 05 — Idempotência nas transferências

## O que o Escopo 5 pedia

O contrato do `Idempotency-Key` (header UUID obrigatório em `POST /transactions/transfer`), a máquina de estados para reuso de chave, a constraint `UNIQUE` no banco tratada como sinal de corrida (não só uma checagem prévia), e o lock otimista via `wallets.version` como garantia de correção sob concorrência — mesmo antes do lock distribuído do Escopo 6 existir.

Se a seção "Idempotência" de [`00-conceitos-gerais.md`](./00-conceitos-gerais.md) não estiver clara, vale reler antes daqui.

## Como foi resolvido

Toda a lógica vive em `TransactionsService` (`apps/backend/src/transactions/transactions.service.ts`). O fluxo de `transfer()` tem duas fases bem distintas: **registrar a intenção** (`createPendingTransaction`) e **executar o efeito** (`executeTransfer`), e essa separação é o que torna a idempotência possível.

### Fase 1 — registrar a intenção, deixando o banco arbitrar a corrida

```ts
private async createPendingTransaction(originWalletId, destinationWalletId, amount, idempotencyKey) {
  try {
    const transaction = await this.prisma.transaction.create({
      data: { originWalletId, destinationWalletId, amount, idempotencyKey, status: 'PENDING' },
    });
    return { transaction, alreadyProcessed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return this.handleIdempotencyKeyReuse(idempotencyKey, originWalletId);
    }
    throw error;
  }
}
```

O ponto central: o código **não** faz `SELECT` para checar se a chave já existe antes de tentar o `INSERT`. Ele tenta o `INSERT` direto e trata o erro `P2002` (violação de constraint única do Prisma) como o sinal de que a chave já existe. Por quê isso importa: um `SELECT` seguido de `INSERT` tem uma janela de corrida (*TOCTOU* — time-of-check to time-of-use) onde duas requisições concorrentes com a mesma chave podem, ambas, passar pelo `SELECT` (nenhuma encontra nada) e ambas tentarem o `INSERT` — só uma vence, mas a outra precisa de um plano B de qualquer forma. Deixar o banco (a constraint `UNIQUE` em `idempotency_key`, ver [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md)) arbitrar a corrida elimina essa janela: não existe forma de duas transações concorrentes inserirem a mesma chave com sucesso, ponto final, garantido pelo Postgres.

### Fase 2 — a máquina de estados de reuso de chave

```ts
private async handleIdempotencyKeyReuse(idempotencyKey, requestingOriginWalletId) {
  const existing = await this.prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (!existing) throw new ConflictException('Conflito ao processar a chave de idempotência');

  if (existing.originWalletId !== requestingOriginWalletId) {
    throw new ConflictException('Chave de idempotência já usada em outra operação');
  }
  if (existing.status === 'COMPLETED') return { transaction: existing, alreadyProcessed: true };
  if (existing.status === 'PENDING')   throw new ConflictException('Operação ainda em processamento');
  throw new ConflictException('A tentativa anterior com esta chave falhou; use uma nova Idempotency-Key');
}
```

Cada ramo responde a uma pergunta diferente sobre o que aconteceu com a tentativa anterior:

| Estado da transação existente | Resposta | Por quê |
|---|---|---|
| `COMPLETED` | retorna a transação existente, **sem reprocessar** | esta é a idempotência de verdade: o cliente que reenviou por timeout/retry recebe o mesmo resultado da primeira vez, sem debitar de novo |
| `PENDING` (ou de outra carteira de origem) | 409 | ou está sendo processada agora mesmo (corrida real), ou a chave foi reaproveitada indevidamente para uma operação diferente — nenhum dos dois casos deveria "só tentar de novo" silenciosamente |
| `FAILED` | 409, pedindo uma **nova** chave | uma falha de negócio (ex.: saldo insuficiente) não é um problema de rede — reenviar a mesma chave não vai fazer a operação ter sucesso, e "reprocessar" uma falha automaticamente seria surpreendente. O cliente precisa decidir conscientemente tentar de novo, com uma chave nova |

O frontend (ver [`11-frontend.md`](./11-frontend.md)) já é desenhado em torno exatamente dessa distinção: reaproveita a mesma `Idempotency-Key` só em caso de erro de rede (sem resposta do servidor — a operação pode ou não ter chegado a acontecer), e sempre gera uma chave nova depois de um erro definitivo do servidor.

### Fase 2.5 — o lock otimista, garantia de correção que independe do Redis

Dentro de `executeTransfer`, ainda antes do Escopo 6 introduzir o lock distribuído, a correção sob concorrência já vinha de uma checagem em cada `UPDATE`:

```ts
const debit = await tx.wallet.updateMany({
  where: { id: originWalletId, version: freshOrigin.version },
  data: { balance: { decrement: amount }, version: { increment: 1 } },
});
if (debit.count !== 1) throw new ConcurrentModificationError();
```

`updateMany` com `WHERE id = X AND version = <versão lida>` só afeta uma linha se `version` ainda for exatamente a que foi lida no início da transação. Se outra transação concorrente já mudou a carteira nesse meio-tempo, `version` não bate mais, `count` vem `0`, e o código sabe — sem precisar de nenhum lock explícito — que perdeu a corrida. A transação inteira é então revertida (`prisma.$transaction` faz rollback automático ao lançar) e a transferência é marcada `FAILED`.

Essa é a garantia de correção de **última instância** deste sistema: mesmo que o Redis inteiro esteja fora do ar, ou que o lock distribuído (Escopo 6) expire no meio de uma operação lenta, é fisicamente impossível duas transferências concorrentes corromperem o saldo de uma carteira — o pior caso é uma das duas ser rejeitada com 409 e precisar ser reenviada.

### Validação de payload

`TransferDto` (`src/transactions/dto/transfer.dto.ts`): `destinationWalletId` (UUID), `amount` (inteiro positivo em centavos). Auto-transferência (`originWallet.id === destinationWallet.id`) e saldo insuficiente são rejeitados com 400 antes mesmo de tentar o lock ou a transação SQL — falha rápido, sem gastar recursos de infraestrutura em requisições que já sabemos que vão falhar.

## Como se conecta com o resto do sistema

- O `try/catch` em torno de `redisLockService.withLock(...)` em `doTransfer` é a costura entre este escopo e o Escopo 6 — ver [`06-lock-distribuido-redis.md`](./06-lock-distribuido-redis.md).
- O `outboxEvent.create` dentro da mesma `$transaction` é a costura com o Escopo 7 — ver [`07-outbox-pattern.md`](./07-outbox-pattern.md).
- `@Max` em `TransferDto.amount` (limite de R$ 1.000.000) só entrou no Escopo 14, depois de perceber que `@IsInt` sozinho aceita `1e21` (JavaScript considera isso um inteiro), valor grande o bastante para estourar o `BIGINT` do Postgres e devolver 500 em vez de 400 — ver [`14-seguranca.md`](./14-seguranca.md).

## Como validar

```bash
cd apps/backend
npm run test                          # 12 unitários cobrindo os ramos de idempotência/erro
docker compose stop backend           # ver nota no Escopo 9 sobre por que
npm run test:e2e -- transfer          # 5 e2e, incluindo teste de concorrência real
docker compose up -d backend
```

O teste de concorrência real do `transfer.e2e-spec.ts` dispara duas requisições HTTP simultâneas (`Promise.all`) debitando a mesma carteira, e confirma que exatamente uma vence e o saldo final está correto — a prova empírica de que a combinação idempotência + lock otimista funciona sob carga de verdade, não só na teoria.
