# 12 — Depósito via AbacatePay (PIX, sempre em dev mode)

> Escopo adicionado depois do Escopo 11, a pedido do usuário: em vez de um botão "adicionar saldo" que só incrementava a coluna `balance` diretamente (sem nenhum registro, sem passar pela mesma disciplina do resto do sistema), integrar um gateway de pagamento de verdade — mas só em modo desenvolvimento, sem nenhuma cobrança real acontecer.

## O que o Escopo 12 pedia

Um cliente HTTP para a API v2 do AbacatePay, um fluxo de criação de depósito que gera um checkout hospedado, prevenção de depósito duplo usando o mesmo padrão de lock otimista das transferências, e um frontend que abre o checkout numa nova aba e faz polling do status.

## Como foi resolvido

### De cartão para PIX: uma restrição de conta, não de código

O pedido original era só cartão. Durante a implementação, a conta AbacatePay usada no projeto retornou `"CARD is not available for this store"` ao criar um checkout com `methods: ['CARD']` — uma restrição do lado da conta/dashboard deles, que exigiria contato com o suporte para ser resolvida. Em vez de bloquear o projeto nisso, a troca foi para PIX, e o impacto no código foi mínimo:

```ts
async createPixCheckout(productId: string, returnUrl: string, completionUrl: string): Promise<AbacatePayCheckout> {
  const data = await this.request<AbacatePayCheckout>('/checkouts/create', {
    method: 'POST',
    body: { items: [{ id: productId, quantity: 1 }], methods: ['PIX'], returnUrl, completionUrl },
  });
  return data;
}
```

Só o array `methods` e o nome do método mudaram (`createCardCheckout` → `createPixCheckout`). Todo o resto — checkout hospedado, polling, prevenção de depósito duplo — é **agnóstico ao método de pagamento**, porque a arquitetura nunca dependeu de detalhes específicos de cartão ou PIX; ela só precisa de um id de checkout e um status (`PENDING`/`PAID`/`EXPIRED`/`CANCELLED`). Esse é um exemplo prático de uma decisão de design (separar o "como pagar" do "como confirmar que foi pago") que absorveu uma mudança de requisito externa sem reescrever nada estrutural.

### `AbacatePayService` — API v2, descoberta empiricamente

```ts
interface AbacatePayEnvelope<T> { success: boolean; data: T | null; error: string | null; }
```

O comentário no código é direto sobre uma realidade comum ao integrar com APIs de terceiros em fase de crescimento: a documentação pública disponível durante a implementação ainda descrevia a v1, então os formatos reais (`POST /products/create`, `POST /checkouts/create`, `GET /checkouts/list`) foram confirmados batendo diretamente contra a API real. Um achado relevante: **não existe endpoint de get único por checkout** — `GET /checkouts/one?id=` responde 404. `findCheckoutById` compensa isso listando todos os checkouts e filtrando em memória:

```ts
async findCheckoutById(id: string): Promise<AbacatePayCheckout | null> {
  const checkouts = await this.request<AbacatePayCheckout[]>('/checkouts/list', { method: 'GET' });
  return checkouts.find((checkout) => checkout.id === id) ?? null;
}
```

Isso é aceitável para o volume de um projeto que nunca sai de dev mode; numa integração de produção com volume real, esse padrão exigiria um cache local do status do checkout para não crescer linearmente com o histórico de checkouts da conta a cada consulta.

### `DepositsService.createDeposit` — um produto por depósito

O checkout hospedado da AbacatePay só cobra o preço de um **produto já existente** — não aceita um valor arbitrário informado no momento do checkout. A solução: criar um produto novo, com o preço exato pedido, para cada depósito:

```ts
const product = await this.abacatePayService.createProduct(randomUUID(), PRODUCT_NAME, amountCents);
const checkout = await this.abacatePayService.createPixCheckout(product.id, callbackUrl, callbackUrl);
```

O `depositId` é gerado **antes** do `create` do Prisma (`randomUUID()` explícito, em vez de deixar o banco/Prisma decidir) especificamente para poder ser embutido na `callbackUrl` enviada à AbacatePay: assim, quando o usuário é redirecionado de volta para `/deposits/callback?depositId=...`, essa própria aba já sabe qual depósito consultar — sem depender de a aba original (que fez o polling) continuar aberta, o que não é garantido (pode ter sido fechada, recarregada, ou o usuário navegou para outro lugar nesse meio-tempo).

### Nunca confiar no redirect — sempre reconfirmar contra a fonte de verdade

```ts
async getDepositForUser(depositId: string, userId: string): Promise<WalletDeposit> {
  const deposit = await this.prisma.walletDeposit.findUnique({ where: { id: depositId }, include: { wallet: true } });
  if (!deposit) throw new NotFoundException(...);
  if (deposit.wallet.userId !== userId) throw new ForbiddenException(...);

  if (deposit.status !== 'PENDING') return deposit;   // já resolvido, nada a checar de novo

  const checkout = await this.abacatePayService.findCheckoutById(deposit.providerChargeId);
  if (!checkout || checkout.status === 'PENDING') return deposit;
  if (checkout.status === 'PAID') return this.confirmPaid(deposit.id, deposit.walletId, deposit.amount);
  ...
}
```

O princípio de segurança por trás disso: `returnUrl`/`completionUrl` são apenas URLs que o navegador do usuário visita depois do checkout — **não são prova de nada**. Um usuário mal-intencionado poderia navegar manualmente para `/deposits/callback?depositId=X` sem nunca ter pagado, e nada nesse redirect por si só credita saldo algum. `getDepositForUser` sempre volta à AbacatePay e pergunta o status real antes de considerar qualquer coisa como paga — o redirect é só uma pista de UX ("volte aqui para ver o resultado"), nunca uma fonte de verdade.

### Prevenção de depósito duplo — o mesmo truque do Escopo 5, num contexto novo

```ts
private async confirmPaid(depositId: string, walletId: string, amount: bigint): Promise<WalletDeposit> {
  return this.prisma.$transaction(async (tx) => {
    const updated = await tx.walletDeposit.updateMany({
      where: { id: depositId, status: 'PENDING' },   // só afeta 1 linha se ainda estava PENDING
      data: { status: 'PAID', paidAt: new Date() },
    });

    if (updated.count === 1) {
      await tx.wallet.update({
        where: { id: walletId },
        data: { balance: { increment: amount }, version: { increment: 1 } },
      });
      await tx.ledgerEntry.create({ data: { walletId, depositId, direction: 'CREDIT', amount } });
    }
    return tx.walletDeposit.findUniqueOrThrow({ where: { id: depositId } });
  });
}
```

O mecanismo é idêntico em espírito ao lock otimista das transferências (Escopo 5): `updateMany` com uma condição no `WHERE` (`status: 'PENDING'`) só afeta uma linha se a condição ainda for verdadeira no momento exato do `UPDATE`. Se o usuário atualiza a página do checkout várias vezes seguidas, ou dois pollings concorrentes chegam quase ao mesmo tempo, todos chamam `confirmPaid` — mas só o primeiro a executar de fato encontra `status = 'PENDING'` e consegue o `count === 1`; todos os outros encontram o depósito já `PAID` (a condição do `WHERE` não bate mais) e o bloco `if` simplesmente não roda, sem creditar nada de novo. Nenhum lock explícito é necessário porque a própria semântica condicional do `UPDATE` já resolve a corrida.

O incremento de `version` junto do `balance` (mesmo fora do fluxo de transferência) é essencial para manter o invariante do lock otimista intacto: se um depósito confirmasse o saldo sem tocar em `version`, uma transferência concorrente que leu a versão antes do depósito poderia, em teoria, sobrescrever esse crédito sem que seu próprio `WHERE version = X` percebesse a mudança.

O `LedgerEntry` gravado na mesma transação SQL do crédito é o que fecha o invariante `saldo == soma do razão` também para depósitos — ver a seção correspondente em [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md) sobre a migration que introduziu isso retroativamente.

### Limite de depósitos pendentes — um problema de acúmulo, não de taxa

```ts
const MAX_PENDING_DEPOSITS_PER_WALLET = 5;
```

Cada `createDeposit` cria **um produto e um checkout novos** na conta da AbacatePay — objetos que nunca são automaticamente removidos de lá. O comentário no código é direto sobre por que rate limiting (que já existe, 10/min) não resolve isso sozinho: o problema não é a *velocidade* de criação, é o *acúmulo* ao longo do tempo — um usuário (ou um bug de retry sem essa proteção) poderia, ao longo de dias, encher a conta do gateway de objetos até ela se tornar impraticável de gerenciar. Limitar a 5 depósitos pendentes por carteira resolve isso na raiz.

## Como se conecta com o resto do sistema

- Reaproveita `WalletsService.invalidateWalletCaches` (Escopo 9) diretamente, sem depender de mensageria — o depósito é confirmado dentro de uma chamada HTTP síncrona (o polling do frontend), então não há razão para atravessar RabbitMQ para invalidar o cache; a invalidação acontece na mesma chamada que confirma o pagamento.
- O frontend (`DashboardPage`, `DepositCallbackPage`) consome `POST /wallets/me/deposits` e faz polling de `GET /wallets/me/deposits/:id` a cada 3s — ver [`11-frontend.md`](./11-frontend.md).
- `getStatement` (Escopo 9/14) lê os `LedgerEntry` gerados aqui exatamente da mesma forma que lê os de transferências — `source: entry.depositId ? 'deposit' : 'transfer'` no DTO de resposta é a única distinção visível ao cliente.

## Como validar

```bash
cd apps/backend
npm run test                    # AbacatePayService (fetch mockado) + DepositsService (tudo mockado)
docker compose stop backend
npm run test:e2e -- wallets     # 14 e2e, com AbacatePayService trocado por um dublê em memória
docker compose up -d backend
```

O teste e2e mais relevante dessa suíte dispara 3 requisições `Promise.all` no mesmo depósito já pago, confirmando que o saldo é creditado **exatamente uma vez**, não três. Validação manual: `POST /wallets/me/deposits` deve retornar um `checkoutUrl` real do tipo `https://app.abacatepay.com/pay/bill_...` — a integração é contra a API real da AbacatePay em modo desenvolvimento, não um mock.
