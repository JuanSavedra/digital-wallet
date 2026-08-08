# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pessoas comuns usando a carteira digital no dia a dia para transferências P2P e depósitos — o mesmo tipo de usuário de um Nubank/PicPay simplificado. Fazem login, veem saldo, transferem para outra pessoa (por e-mail ou id da carteira), consultam extrato, veem detalhe de uma transação, e depositam saldo via PIX.

## Product Purpose

Uma carteira digital para transferências internas (P2P) e depósitos: registrar usuário, manter saldo, transferir entre carteiras com segurança sob concorrência, consultar extrato e detalhe de transações, e depositar via PIX (AbacatePay, modo dev — nunca dinheiro real).

## Positioning

Confiança e solidez: por trás da interface há transações ACID, ledger append-only, lock distribuído, idempotência e outbox pattern garantindo que o saldo mostrado é sempre correto e nunca duplicado. O design deve comunicar essa precisão e seriedade — nada de aparência "brinquedo" ou frágil, mesmo sendo um produto simples.

## Operating Context

- Fluxo: Login/Register → Dashboard (saldo + ações) → Transfer (envia por e-mail ou wallet id) → Statement (extrato paginado) → TransactionDetail (visão de uma transação específica) → Deposit via PIX (checkout hospedado externo + polling de status).
- Sessão expira ao recarregar a página (token de acesso em memória); a aplicação restaura a sessão via refresh silencioso, então há sempre um estado de carregamento inicial antes do dashboard aparecer.
- Depósito PIX abre uma aba nova para o checkout (QR code / copia-e-cola) enquanto a aba original faz polling do status — a UI precisa comunicar "aguardando confirmação" claramente.
- Valores monetários são sempre em reais (BRL), armazenados como centavos inteiros — nunca ponto flutuante.

## Capabilities and Constraints

- Uma carteira por usuário, criada automaticamente no registro — não existe fluxo de "criar carteira".
- Transferências e depósitos passam por lock distribuído/otimista; a UI deve tolerar retries e não pode assumir sucesso imediato sem confirmação do servidor.
- Todo valor monetário exibido vem de centavos inteiros formatados para BRL.
- Sem app mobile nativo — plataforma é web (SPA React), responsivo é suficiente.
- Sem sistema de notificações push; feedback é sempre síncrono (resposta da API) ou via polling (depósito).

## Brand Commitments

Nenhum nome de marca, logo ou identidade visual pré-existente — "Digital Wallet" é o nome técnico do repositório, não uma marca fixada. Sem assets de marca no projeto até o momento.

## Evidence on Hand

Nenhum conteúdo real de terceiros (sem depoimentos, casos de uso publicados, imprensa). Todos os dados são gerados pelo próprio usuário ao usar a aplicação (contas, transferências, extrato). Não inventar prova social, métricas ou clientes.

## Product Principles

- Precisão antes de estética: nenhum elemento visual pode sugerir um valor, status ou saldo que não bata com o que o backend confirmou.
- Estado do dinheiro sempre visível e sem ambiguidade: saldo, entradas e saídas devem ser instantaneamente distinguíveis.
- Tolerância a espera: operações financeiras (transferência, depósito) podem levar tempo para confirmar — a UI deve deixar isso explícito, nunca fingir instantaneidade.
- Simplicidade funcional: poucas telas, poucas ações por tela, sem decoração que não sirva à tarefa.

## Accessibility & Inclusion

Nenhum requisito específico de acessibilidade foi estabelecido além dos padrões web (contraste adequado em ambos os temas, navegação por teclado nos fluxos de autenticação e transferência).
