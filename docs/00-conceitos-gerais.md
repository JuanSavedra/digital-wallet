# 00 — Conceitos gerais

Antes de entrar escopo por escopo, vale alinhar o vocabulário. Estes são os conceitos que aparecem repetidamente na documentação e que, se você não tiver claros, vão fazer decisões de código parecerem arbitrárias.

## Dinheiro é inteiro, nunca ponto flutuante

`0.1 + 0.2 !== 0.3` em qualquer linguagem que usa `float`/`double` (IEEE 754), porque frações decimais nem sempre têm representação binária exata. Num sistema financeiro isso não é um detalhe cosmético — é dinheiro sumindo ou aparecendo por erro de arredondamento.

A solução padrão da indústria: guardar valores monetários como **inteiros na menor unidade da moeda** (centavos, no caso do BRL). R$ 10,50 é armazenado como `1050`. Toda a aritmética (somar, subtrair, comparar) é aritmética de inteiros, exata por definição. A conversão para "reais e centavos" só acontece na borda — ao exibir para o usuário.

Neste projeto isso vai um passo além: os campos monetários no Postgres são `BigInt` (não `Int` de 32 bits), porque um `Int` de 32 bits estoura em ~R$ 21 milhões (2³¹centavos). Isso tem uma consequência prática chata: **`BigInt` não é serializável por `JSON.stringify` nativamente** — `JSON.stringify(10n)` lança `TypeError`. Todo DTO de resposta que carrega um valor monetário converte para `string` antes de sair pela API (ver [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md)).

## Idempotência

Uma operação é **idempotente** quando executá-la uma vez ou N vezes produz o mesmo resultado observável. `PUT /users/1 {name: "Ana"}` é naturalmente idempotente — repetir não muda nada. `POST /transactions/transfer {amount: 100}` **não é** — cada `POST` bem-sucedido debita de novo.

O problema real: um cliente HTTP não sabe, com certeza, se uma requisição que deu timeout foi processada no servidor antes de a resposta se perder. A única forma segura de retry é o cliente enviar uma **chave de idempotência** (um UUID gerado por ele, único por tentativa lógica) e o servidor garantir que a mesma chave nunca produz o efeito duas vezes, não importa quantas vezes a requisição chegue.

Neste projeto isso é o `Idempotency-Key` do `POST /transactions/transfer` — ver [`05-idempotencia-transferencias.md`](./05-idempotencia-transferencias.md) para a máquina de estados completa (o que acontece se a chave já foi usada por uma transação `COMPLETED`, `PENDING`, ou `FAILED`).

## Lock otimista vs. lock distribuído — por que os dois

São duas ferramentas para o mesmo problema (duas operações concorrentes mexendo no mesmo dado), com trade-offs diferentes, e este projeto usa as duas **em camadas**, não como alternativas.

**Lock otimista** (coluna `version`): não impede duas transações de lerem o mesmo registro ao mesmo tempo. Cada `UPDATE` inclui `WHERE version = <versão lida>`; se outra transação já mudou a linha nesse meio-tempo, `version` não bate mais, o `UPDATE` afeta zero linhas, e o código detecta isso e trata como conflito. É barato (não segura nada, só verifica no `UPDATE`) e é a garantia de **correção** que sobrevive a qualquer coisa — mesmo se o Redis inteiro cair.

**Lock distribuído** (Redis, `SET key token PX ttl NX`): impede fisicamente que duas execuções concorrentes entrem na seção crítica ao mesmo tempo — quem perde a corrida do `SET NX` espera ou desiste. É mais caro (uma chamada de rede a mais, gerência de TTL) mas evita que duas requisições cheguem simultaneamente até o banco só para uma delas descobrir, tarde, que perdeu a corrida do lock otimista.

Na prática: sem o lock distribuído, sob alta concorrência numa mesma carteira, muitas requisições chegariam ao Postgres, perderiam a corrida do `version` e voltariam erro pro cliente — desperdício de round-trips e uma experiência pior (o cliente vê "conflito, tente de novo" com mais frequência). Com o lock distribuído, a maioria das requisições concorrentes já espera sua vez antes de tocar o banco, e o lock otimista vira uma rede de segurança que raramente dispara (só dispara de verdade se o TTL do lock expirar no meio de uma operação lenta, ou se o Redis ficar indisponível).

Ver [`06-lock-distribuido-redis.md`](./06-lock-distribuido-redis.md).

## Outbox pattern

Problema: depois que uma transferência é persistida no Postgres, o sistema precisa publicar um evento no RabbitMQ (`transaction.completed`) para que outros componentes reajam (invalidação de cache, no caso deste projeto). Mas escrever em dois sistemas diferentes (Postgres e RabbitMQ) não é atômico — não existe uma transação distribuída simples entre os dois. Se você escrever no Postgres e **depois** publicar no RabbitMQ, existe uma janela onde o commit no Postgres teve sucesso mas a publicação falhou (o processo caiu entre as duas chamadas) — o evento nunca é publicado e nada mais no sistema sabe que a transferência aconteceu.

A solução (outbox pattern): em vez de publicar diretamente, você insere uma linha numa tabela `outbox_events` **na mesma transação SQL** que grava a operação de negócio. Ou as duas coisas commitam juntas, ou nenhuma commita — isso é uma garantia nativa do Postgres, sem precisar de coordenação distribuída. Um processo separado (o "relay", aqui `OutboxRelayService`) varre essa tabela periodicamente e publica de verdade no RabbitMQ, marcando cada evento como publicado só depois de confirmação do broker.

Efeito colateral aceito: o evento pode ser publicado com um pequeno atraso (aqui, até 2s — o intervalo do relay) em vez de instantaneamente. Essa é a troca deliberada: consistência garantida em vez de latência mínima.

Ver [`07-outbox-pattern.md`](./07-outbox-pattern.md).

## At-least-once delivery, retry e idempotência do lado do consumidor

RabbitMQ (como a maioria dos brokers de mensageria) entrega mensagens com garantia **at-least-once**: uma mensagem pode ser entregue mais de uma vez (ex.: o consumidor processou mas caiu antes de confirmar o `ack`, e o broker reentrega por segurança), mas nunca é perdida silenciosamente. A consequência prática: **todo consumidor precisa ser idempotente**, tratando reentrega como um caso normal, não uma exceção.

Este projeto resolve isso combinando duas coisas:
- **Ack manual** (`noAck: false`): a mensagem só é removida da fila depois que o processamento decide seu destino (sucesso, retry, ou DLQ) — nunca antes.
- **Dedupe via Redis**: antes de processar, o consumidor tenta `SET NX` numa chave derivada do id do evento; se a chave já existe, é uma reentrega e a mensagem é confirmada sem reprocessar.

Quando o processamento falha de verdade (não é reentrega, é erro), a mensagem não é simplesmente reenfileirada na hora — isso criaria um loop apertado de retry sem espaçamento. Em vez disso, vai para uma fila de "espera" com TTL crescente (backoff exponencial) que, ao expirar, devolve a mensagem para a fila principal. Depois de um número máximo de tentativas, vai para uma **dead-letter queue (DLQ)** — um lugar para mensagens que consistentemente falham, permitindo inspeção e reprocessamento manual sem bloquear o fluxo normal.

Ver [`08-rabbitmq-retry-dlq.md`](./08-rabbitmq-retry-dlq.md).

## Cache-aside

A estratégia de cache mais simples e mais usada: a aplicação lê primeiro do cache; se não encontrar (*miss*), lê da fonte de verdade (Postgres) e escreve o resultado no cache antes de retornar. Escritas **não** passam pelo cache (isso seria *write-through*) — a transferência apenas grava no Postgres normalmente, e um processo separado invalida as chaves de cache afetadas depois.

A vantagem de cache-aside sobre write-through aqui: a escrita (transferência) continua simples e não precisa saber nada sobre cache. A desvantagem: existe uma janela entre a escrita e a invalidação onde o cache pode estar desatualizado — por isso todo valor cacheado neste projeto tem um TTL de segurança curto (30-60s) além da invalidação ativa, para o caso de a invalidação falhar ou atrasar.

Ver [`09-cache-saldo-extrato-redis.md`](./09-cache-saldo-extrato-redis.md).

## Ledger de dupla entrada (double-entry bookkeeping)

Em vez de confiar apenas numa coluna `wallets.balance` que é incrementada/decrementada diretamente, o sistema mantém um **livro-razão** (`transaction_entries`) onde toda movimentação gera lançamentos explícitos: um `DEBIT` na carteira de origem e um `CREDIT` na carteira de destino, cada um com valor sempre positivo (o sinal vem da direção, não do valor). Esse é o modelo contábil usado por sistemas financeiros de verdade há séculos, não uma invenção deste projeto.

Por quê isso importa além de "parecer profissional": um `balance` que só existe como coluna mutável não tem como provar, depois do fato, que está correto — se um bug incrementou errado, não há trilha. Com o ledger, `wallets.balance` deveria ser sempre igual a `SUM(transaction_entries.amount de CREDIT) - SUM(transaction_entries.amount de DEBIT)` para aquela carteira — um invariante auditável a qualquer momento, independente da coluna. Neste projeto o ledger também é **append-only forçado no banco** (triggers rejeitam `UPDATE`/`DELETE`), então nem um bug nem um acesso direto ao Postgres consegue reescrever a história.

Ver a seção "Ledger append-only" em [`14-seguranca.md`](./14-seguranca.md) e o modelo de dados em [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md).

## JWT: access token vs. refresh token, e por que dois

Um único token de longa duração é conveniente mas perigoso: se vazar (XSS, log, etc.), o atacante tem acesso prolongado. Um único token de curta duração é seguro mas obriga o usuário a logar de novo a cada poucos minutos.

A solução padrão: dois tokens.
- **Access token**: curto (aqui, 15 minutos), enviado em todo request autenticado, stateless (o servidor não guarda nada sobre ele — só valida a assinatura). Se vazar, a janela de exposição é pequena.
- **Refresh token**: longo (aqui, 7 dias), usado só para pedir um novo access token, e cujo uso o servidor consegue revogar (porque o servidor rastreia quais refresh tokens são válidos).

Neste projeto o rastreamento é uma **allowlist rotativa no Redis**: cada refresh token tem um `jti` (JWT ID) único, e existe uma chave `auth:refresh:<jti>` no Redis enquanto aquele token for válido. Usar o refresh token deleta essa chave e cria uma nova (para o próximo par de tokens) — então cada refresh token só pode ser usado **uma vez**. Se alguém reusar um refresh token já consumido (sinal de que ele vazou e foi usado por dois lados), a chave já não existe, e a tentativa é rejeitada.

Ver [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md).

## Por que o refresh token vive num cookie `httpOnly` e o access token só em memória

Dois vetores de ataque diferentes, duas defesas diferentes:

- **XSS** (script malicioso rodando no seu próprio frontend, injetado por uma dependência comprometida ou um input mal sanitizado): se o token estiver em `localStorage` ou numa variável acessível por JS, o script malicioso lê e exfiltra. A defesa é nunca deixar o token em algo que JavaScript consegue ler. Um cookie `HttpOnly` é literalmente invisível para `document.cookie` — só o navegador o anexa automaticamente às requisições.
- **CSRF** (um site malicioso fazendo o navegador da vítima disparar requisições para o site legítimo, aproveitando que cookies são anexados automaticamente): a defesa aqui é `SameSite=Strict` no cookie — o navegador não anexa o cookie em requisições originadas de outro site, então o `POST` forjado chega sem credencial.

A composição usada neste projeto: o **access token** vive só em memória no frontend (nunca em `localStorage`, nunca em cookie) — um XSS ainda pode roubá-lo enquanto a aba está aberta, mas ele expira em 15 minutos e não sobrevive a um F5. O **refresh token**, que é o que dura 7 dias e realmente importa proteger, vive num cookie `HttpOnly; SameSite=Strict` — inacessível a JavaScript (então um XSS não consegue roubá-lo) e protegido de CSRF pelo `SameSite`.

Ver a seção correspondente em [`14-seguranca.md`](./14-seguranca.md).

## Correlation ID / request ID

Num sistema com múltiplos processos (API, relay da outbox, consumidor RabbitMQ), depurar "o que aconteceu com a transferência X" olhando logs soltos de cada processo é lento. A solução é gerar um identificador único por requisição (`x-request-id`) na borda (ou aceitar um já existente, se o cliente propagar) e fazer esse identificador atravessar todas as camadas — inclusive dentro do payload do evento publicado no RabbitMQ — para que um `grep` por esse id nos logs reconstrua a história completa de ponta a ponta.

Ver [`02-backend-estrutura-base.md`](./02-backend-estrutura-base.md) e [`13-observabilidade-qualidade.md`](./13-observabilidade-qualidade.md).
