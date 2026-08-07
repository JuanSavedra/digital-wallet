# 04 — Modelagem de dados (PostgreSQL)

## O que o Escopo 4 pedia

As tabelas `users`, `wallets`, `transactions`, `transaction_entries` (ledger) e `outbox_events`, com migrations versionadas via Prisma Migrate, índices nas colunas consultadas com frequência, e `CHECK` constraints de integridade financeira (`balance >= 0`, `amount > 0`) — estes últimos adicionados manualmente na migration gerada, porque a DSL do Prisma não tem uma forma nativa de declarar `@@check` (verdadeiro em 2026; se isso mudar em uma versão futura do Prisma, o schema pode migrar para a forma declarativa, mas o comportamento no banco continua o mesmo).

`users`/`wallets` já existiam desde o Escopo 3 (pré-requisito do auth). Este escopo formaliza o restante do modelo financeiro.

## Como foi resolvido

### O schema completo (`apps/backend/prisma/schema.prisma`)

```
User 1───1 Wallet 1───* Transaction (origin)  ─┐
                │  └─* Transaction (destination) ├─* LedgerEntry (transaction_entries)
                └─────* WalletDeposit ───────────┘
                                                    OutboxEvent (sem FK — desacoplado de propósito)
```

- **`User`**: `id`, `email` (`@unique`), `passwordHash`, timestamps.
- **`Wallet`**: `userId` **`@unique`** — é essa constraint, não uma regra de aplicação, que garante "uma carteira por usuário" no nível do banco. `balance BigInt` (centavos), `version Int` (lock otimista, ver [`06-lock-distribuido-redis.md`](./06-lock-distribuido-redis.md)).
- **`Transaction`**: `originWalletId`/`destinationWalletId`, `amount BigInt`, `status` (`PENDING`/`COMPLETED`/`FAILED`), `idempotencyKey` **`@unique`** — a constraint que torna a idempotência à prova de corrida (ver [`05-idempotencia-transferencias.md`](./05-idempotencia-transferencias.md)).
- **`LedgerEntry`** (tabela `transaction_entries`): o livro-razão de dupla entrada — ver a seção dedicada abaixo.
- **`OutboxEvent`**: `aggregateId` **sem foreign key** de propósito — a tabela é genérica, pensada para eventualmente carregar eventos de agregados além de `Transaction`, então não faz sentido acoplá-la a uma tabela específica via FK.
- **`WalletDeposit`** (Escopo 12, adicionada depois): depósitos via AbacatePay — ver [`12-deposito-abacatepay.md`](./12-deposito-abacatepay.md).

### Money é `BigInt`, e isso tem uma pegadinha de serialização

Todo campo monetário (`balance`, `amount`) é `BigInt` no Prisma — mapeado para `BIGINT` no Postgres, suficiente para valores muito acima de qualquer cenário realista deste projeto, ao contrário de um `INTEGER` de 32 bits que estouraria perto de R$ 21 milhões em centavos. A pegadinha, documentada no próprio `TODO.md` como aviso para escopos futuros: **`JSON.stringify` não serializa `BigInt` nativamente** — `JSON.stringify(10n)` lança `TypeError: Do not know how to serialize a BigInt`. Todo DTO de resposta que carrega um valor monetário converte explicitamente para `string` antes de ele chegar no `res.json()` (ver os DTOs em `src/wallets/dto/` e `src/transactions/dto/`).

### `CHECK` constraints — defesa que não depende do código da aplicação

```sql
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "transaction_entries" ADD CONSTRAINT "transaction_entries_amount_positive" CHECK ("amount" > 0);
```

A ideia por trás disso: validação na aplicação (DTOs, `class-validator`) previne a maioria dos casos, mas é uma segunda linha de defesa — não a única. Se um bug futuro em algum service tentar decrementar um saldo abaixo de zero, ou inserir um valor zero/negativo, o Postgres rejeita a escrita **mesmo que o código da aplicação tenha um bug**. Isso foi testado de propósito inserindo saldo negativo e valor zero diretamente contra o Postgres real (não só mockado), confirmando que a rejeição realmente acontece no banco.

### O ledger de dupla entrada (`transaction_entries`)

Cada transferência bem-sucedida gera **dois** lançamentos na mesma operação — um `DEBIT` na carteira de origem, um `CREDIT` na carteira de destino, ambos com `amount` sempre positivo (o sinal da movimentação vem do campo `direction`, nunca do valor). Ver a motivação conceitual completa em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md#ledger-de-dupla-entrada-double-entry-bookkeeping).

Uma decisão de modelagem que só chegou no Escopo 14, mas vive nesta tabela: originalmente `transactionId` era obrigatório (todo lançamento vinha de uma transferência). Quando os depósitos via AbacatePay passaram a existir, ficou claro que um depósito confirmado também precisa gerar um `CREDIT` no ledger — senão `saldo != soma(ledger)` e a tabela deixa de servir para auditoria. A correção: `transactionId` virou opcional, entrou `depositId` (também opcional), e um `CHECK` garante que **exatamente um** dos dois esteja preenchido:

```sql
ALTER TABLE "transaction_entries"
  ADD CONSTRAINT "transaction_entries_source_exactly_one"
  CHECK (("transaction_id" IS NULL) <> ("deposit_id" IS NULL));
```

`<>` (diferente) sobre dois booleanos é exatamente um XOR — a constraint rejeita tanto um lançamento órfão (nenhuma origem) quanto um ambíguo (as duas origens ao mesmo tempo). Depósitos já pagos antes dessa migration foram *backfilled* por um `INSERT ... SELECT` dentro da própria migration (ver o SQL completo em `prisma/migrations/20260807210000_add_ledger_deposits_and_append_only/`), para que o invariante passasse a valer também para o histórico já existente.

### Append-only garantido por trigger, não por convenção

O comentário "livro-razão imutável" no schema não seria suficiente sozinho — comentário não impede um `UPDATE` acidental (ou malicioso, com acesso direto ao banco). A garantia real está em duas triggers:

```sql
CREATE TRIGGER "transaction_entries_no_update"
  BEFORE UPDATE ON "transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "transaction_entries_append_only"();

CREATE TRIGGER "transaction_entries_no_delete"
  BEFORE DELETE ON "transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "transaction_entries_append_only"();
```

A função por trás delas lança uma exceção Postgres (`RAISE EXCEPTION ... USING ERRCODE = 'restrict_violation'`) para qualquer `UPDATE`/`DELETE`, com uma única escotilha: a flag de sessão `app.ledger_maintenance`. Essa flag nunca é ligada pelo código da aplicação — só existe para a limpeza dos testes e2e, que precisam apagar as linhas que os próprios testes criaram entre uma execução e outra (`test/utils/ledger-cleanup.ts`, ver [`13-observabilidade-qualidade.md`](./13-observabilidade-qualidade.md)). Detalhe prático que já pegou quem tentou limpar o banco de teste manualmente: `prisma.ledgerEntry.deleteMany()` **falha** contra este schema — é preciso passar por `deleteLedgerEntries()`, que liga a flag de sessão antes de apagar.

### Índices

`idempotencyKey` (`@unique`, também serve de índice), `originWalletId`/`destinationWalletId`/`status` em `Transaction`, `walletId`/`transactionId`/`depositId` em `LedgerEntry`, `status`/`aggregateId` em `OutboxEvent`. Todos escolhidos pelas colunas efetivamente usadas em `WHERE` pelos services correspondentes (ex.: o relay da outbox filtra por `status = PENDING`; o guard de ownership de carteira e o extrato filtram por `walletId`).

### Migrations versionadas, sem "db push mágico"

Todas as mudanças de schema passam por `prisma migrate dev` (gera e aplica a migration em desenvolvimento, com o SQL versionado em `prisma/migrations/`) — nunca `prisma db push`, que sincroniza o schema direto sem deixar rastro histórico do que mudou e por quê. Em produção (e dentro do container Docker, ver [`01-infraestrutura-local.md`](./01-infraestrutura-local.md)), `prisma migrate deploy` aplica só as migrations já commitadas, sem gerar nada novo nem pedir confirmação interativa.

## Como se conecta com o resto do sistema

- `wallets.version` é a base do lock otimista usado por `TransactionsService.executeTransfer` (Escopo 5) e por `DepositsService.confirmPaid` (Escopo 12).
- `transactions.idempotency_key @unique` é o que permite ao código tratar uma violação de constraint (`P2002` do Prisma) como sinal de corrida, em vez de confiar só numa checagem prévia via `SELECT` — ver [`05-idempotencia-transferencias.md`](./05-idempotencia-transferencias.md).
- `outbox_events` é lida pelo `OutboxRelayService` do Escopo 7.
- `transaction_entries` é a fonte única de verdade do extrato desde o Escopo 14 (`WalletsService.getStatement` — ver [`09-cache-saldo-extrato-redis.md`](./09-cache-saldo-extrato-redis.md) e [`14-seguranca.md`](./14-seguranca.md)).

## Como validar

```bash
cd apps/backend
npm run prisma:migrate     # aplica migrations locais (requer Postgres via `make up`)
npm run test:e2e -- wallet-schema ledger-audit
```

`test/wallet-schema.e2e-spec.ts` cobre: uma carteira por usuário, saldo negativo rejeitado, débito/crédito no ledger, idempotency key duplicada rejeitada, valor não-positivo rejeitado, evento de outbox pendente. `test/ledger-audit.e2e-spec.ts` bate direto no Postgres para confirmar que `UPDATE`/`DELETE` em `transaction_entries` são bloqueados pela trigger e que o `CHECK` de origem exclusiva funciona.
