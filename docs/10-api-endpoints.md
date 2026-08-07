# 10 — API: endpoints principais

## O que o Escopo 10 pedia

Consolidar a superfície HTTP do sistema. A maior parte já existia dos escopos anteriores (auth no Escopo 3, transferência nos Escopos 5-7, saldo/extrato no Escopo 9) — o único item novo de fato neste escopo é `GET /transactions/:id`, o detalhe de uma transação.

Este documento serve como referência da API completa; para o *como funciona por dentro* de cada grupo de endpoints, veja o documento do escopo correspondente.

## Superfície completa

| Método | Rota | Guard | Escopo | Descrição |
|---|---|---|---|---|
| `POST` | `/auth/register` | — (throttled) | 3 | cria usuário + carteira |
| `POST` | `/auth/login` | — (throttled) | 3 | emite access token; refresh token via cookie |
| `POST` | `/auth/refresh` | — (throttled) | 3 | rotação single-use |
| `POST` | `/auth/logout` | — (throttled) | 3 | revoga o refresh token |
| `GET` | `/users/me` | JWT | 3 | rota protegida de referência |
| `GET` | `/wallets/me` | JWT | 9 | saldo (cache-aside) |
| `GET` | `/wallets/me/statement` | JWT | 9 | extrato paginado (cache-aside) |
| `GET` | `/wallets/lookup?email=` | JWT (throttled) | 11 | resolve `walletId` a partir de e-mail |
| `POST` | `/wallets/me/deposits` | JWT (throttled) | 12 | cria depósito PIX via AbacatePay |
| `GET` | `/wallets/me/deposits/:id` | JWT, dono (throttled) | 12 | consulta/poll de um depósito |
| `GET` | `/wallets/:id` | JWT + `WalletOwnerGuard` | 3 | saldo de uma carteira específica |
| `GET` | `/wallets/:id/statement` | JWT + `WalletOwnerGuard` | 9 | extrato de uma carteira específica |
| `POST` | `/transactions/transfer` | JWT (throttled) | 5/6/7 | cria transferência, exige `Idempotency-Key` |
| `GET` | `/transactions/:id` | JWT, participante | 10 | detalhe de uma transação |
| `GET` | `/admin/dlq` | JWT + `AdminGuard` | 8/14 | tamanho da DLQ |
| `POST` | `/admin/dlq/replay` | JWT + `AdminGuard` | 8/14 | reprocessa a DLQ manualmente |
| `GET` | `/api/metrics` | opcional (`METRICS_TOKEN`) | 13/14 | métricas Prometheus |

Todas as rotas de negócio vivem sob o prefixo `/api/v1/` (ver [`02-backend-estrutura-base.md`](./02-backend-estrutura-base.md)).

## O item novo deste escopo: `GET /transactions/:id`

```ts
@Get(':id')
async findOne(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
  const transaction = await this.transactionsService.findByIdForUser(id, user.userId);
  return toTransactionResponse(transaction);
}
```

A regra de autorização, em `TransactionsService.findByIdForUser`:

```ts
const isParticipant =
  transaction.originWallet.userId === userId ||
  transaction.destinationWallet.userId === userId;
if (!isParticipant) throw new ForbiddenException('Você não tem acesso a esta transação');
```

Diferente de `WalletOwnerGuard` (que checa posse de **uma** carteira), aqui a regra é "participou de qualquer um dos dois lados" — quem enviou ou quem recebeu, ambos podem ver o detalhe. Terceiros recebem 403; um id que não existe recebe 404. `ParseUUIDPipe` no parâmetro de rota rejeita, antes mesmo de chegar no service, qualquer valor que não seja um UUID bem formado — evitando que uma string arbitrária vire uma query desnecessária ao Postgres.

## Padrões consistentes em toda a API

- **Toda rota autenticada exige `JwtAuthGuard`**; autorização fina (dono do recurso, participante, admin) é responsabilidade de um guard/checagem adicional, nunca implícita.
- **Rate limiting é sempre por rota/controller**, nunca global — ver a explicação completa em [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md).
- **`ParseUUIDPipe` em todo parâmetro de rota que deveria ser um UUID** (`/transactions/:id`, `/wallets/:id`, `/wallets/me/deposits/:id`) — adicionado sistematicamente no Escopo 14 depois de perceber que faltava em alguns.
- **DTOs de resposta convertem `BigInt` para `string`** (`toWalletResponse`, `toTransactionResponse`, `toDepositResponse`) — nunca um valor monetário cru sai da API sem passar por essa conversão.
- **`GET /wallets/lookup`** devolve só `{ walletId }`, nunca saldo ou outros dados do dono da carteira — o mínimo necessário para a tela de transferência funcionar, nada além disso (ver [`11-frontend.md`](./11-frontend.md) para o motivo de o endpoint existir).

## Como se conecta com o resto do sistema

Este documento é essencialmente um índice — cada linha da tabela remete a um documento de escopo com os detalhes de implementação, trade-offs e testes daquele grupo de endpoints. O Swagger em `/api/docs` (desligado em produção por padrão) é a fonte viva e sempre atualizada dessa mesma superfície, gerada a partir dos decorators `@ApiTags`/`@ApiBearerAuth`/`@ApiHeader` nos controllers.

## Como validar

```bash
cd apps/backend
npm run test:e2e -- transaction-detail
```

`test/transaction-detail.e2e-spec.ts`: 2 e2e (origem e destino conseguem ver a transação; terceiro recebe 403) + 4 unitários no service. Para a superfície completa, `npm run test:e2e` sem filtro roda as 11 suítes e2e do projeto.
