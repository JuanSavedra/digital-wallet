---
name: Carteira Digital
description: Carteira digital P2P minimalista — precisão financeira em preto, branco e verde, com vermelho reservado só para saídas.
colors:
  ink: "#0a0d0b"
  ink-soft: "#4a534d"
  paper: "#ffffff"
  surface: "#f5f7f5"
  border: "#dfe4e0"
  signal-green: "#146c3f"
  signal-green-strong: "#0e5230"
  signal-green-tint: "#e6f3ea"
  signal-red: "#b3261e"
  signal-red-tint: "#fbeae9"
  signal-amber: "#8a5a00"
  ink-dark: "#eef2ef"
  ink-soft-dark: "#9aa79f"
  paper-dark: "#0a0d0b"
  surface-dark: "#121613"
  border-dark: "#232b26"
  signal-green-dark: "#3ddc84"
  signal-green-strong-dark: "#5ef29b"
  signal-green-tint-dark: "#12271b"
  signal-red-dark: "#ff6b61"
  signal-red-tint-dark: "#2b1512"
  signal-amber-dark: "#e0a83e"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "clamp(2rem, 5vw, 2.75rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
  figure:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.signal-green-strong}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: Carteira Digital

## Overview

**Creative North Star: "The Ledger Line"**

A carteira digital não precisa parecer um app de fintech genérico para parecer confiável — precisa parecer um livro-razão bem feito: precisão, uma cor de ação e nada mais competindo por atenção. Este sistema parte de preto-tinta sobre branco-papel, com verde como a única cor que age (saldo positivo, ações primárias, confirmação) e vermelho reservado estritamente para o que sai da conta ou dá errado. Não há gradiente, não há roxo, não há decoração; a hierarquia vem de peso tipográfico e espaçamento, e os valores monetários usam uma mono para se lerem como o que são — dados, não prosa.

Rejeitado explicitamente: o roxo/gradiente do template padrão do Vite que o projeto tinha antes; qualquer sombra colorida ou "glow"; cards decorativos aninhados; ícones em emoji.

**Key Characteristics:**
- Monocromático (tinta + papel) com um único acento de cor por função: verde para positivo/ação, vermelho para negativo/erro.
- Números monetários sempre em mono, com alinhamento tabular.
- Sem sombra em repouso — profundidade vem de borda de 1px e diferença sutil de superfície.
- Cantos discretamente arredondados (6–16px), nunca pill, nunca 0 (não é neobrutalista).
- Tema claro e escuro têm o mesmo caráter: tinta quase-preta sobre papel quase-branco, invertido.

## Colors

Paleta restrita: dois neutros fazem 90%+ de qualquer tela; verde é o único acento de marca/ação; vermelho é puramente semântico (saída de dinheiro, erro), nunca decorativo.

### Primary
- **Signal Green** (`#146c3f` claro / `#3ddc84` escuro): ações primárias (botões, links de destaque, saldo positivo), estados de sucesso, entradas de dinheiro (`+`). No escuro, mais claro e saturado para manter contraste 4.5:1 sobre o fundo quase-preto.

### Secondary
- **Signal Red** (`#b3261e` claro / `#ff6b61` escuro): exclusivamente saídas de dinheiro (`-`), erros de formulário e status "falhou". Nunca usado como cor de marca ou destaque decorativo.

### Neutral
- **Ink** (`#0a0d0b` claro / `#eef2ef` escuro): texto principal, títulos.
- **Ink Soft** (`#4a534d` claro / `#9aa79f` escuro): texto secundário, legendas, timestamps.
- **Paper** (`#ffffff` claro / `#0a0d0b` escuro): fundo base da aplicação.
- **Surface** (`#f5f7f5` claro / `#121613` escuro): fundo de cards e blocos elevados um nível (ex.: caixa de depósito).
- **Border** (`#dfe4e0` claro / `#232b26` escuro): toda borda de 1px — inputs, divisores de lista, header.

### Named Rules
**The One Accent Rule.** Verde é a única cor não-neutra permitida fora do vermelho semântico. Se um elemento não é uma ação primária, uma entrada de dinheiro ou um estado de sucesso, ele não é verde.

**The Red-Means-Out Rule.** Vermelho só aparece em três situações: valor debitado (`-R$`), erro de formulário/rede, ou status "falhou". Nunca em navegação, marca ou ênfase genérica.

## Typography

**Display/Body Font:** IBM Plex Sans (com fallback `system-ui, sans-serif`)
**Figure Font:** IBM Plex Mono (com fallback `ui-monospace, monospace`)

**Character:** Plex Sans é uma grotesca desenhada para interfaces técnicas — neutra o bastante para não competir com o conteúdo, com peso suficiente nos títulos para dar autoridade sem virar display. Plex Mono entra só onde o dado é literalmente um número ou identificador (saldo, valores de extrato, id de carteira, chave de idempotência) — reforça que aquilo é um valor exato, não um rótulo.

### Hierarchy
- **Display** (600, `clamp(2rem, 5vw, 2.75rem)`, 1.1): título de página (`<h1>`), aparece uma vez por tela.
- **Headline** (600, 20px, 1.2): subtítulos de seção (`<h2>`, ex. "Adicionar saldo").
- **Body** (400, 16px, 1.5): parágrafos, labels de formulário, texto de lista. Medida máxima ~65ch.
- **Label** (500, 13px, 1.3, tracking 0.01em): legendas pequenas, hints, timestamps.
- **Figure** (500, 16–40px conforme contexto, 1.3, mono): saldo, valores de transação, ids, chaves.

### Named Rules
**The Mono-Means-Money Rule.** Mono é reservado para números e identificadores exatos (saldo, valores, ids, chaves de idempotência). Nunca usado como "estética técnica" em texto comum.

## Layout

Coluna única centralizada, largura máxima de conteúdo 560px (formulários/telas de tarefa) — a carteira é uma ferramenta de tarefa curta, não um dashboard denso, então não há grade multi-coluna. Header fixo no topo com marca, navegação e alternador de tema, sempre com borda inferior de 1px, nunca sombra. Espaçamento em escala de 4px (4/8/16/24/40); mais espaço acima de um título do que abaixo dele. Em telas ≤640px, o header colapsa o rótulo da marca para o glifo e a navegação vira ícones com texto oculto por `aria-label`.

## Elevation & Depth

Sistema flat por padrão. Nenhuma sombra em repouso — a separação entre header/conteúdo e entre linhas de lista vem de borda de 1px (`var(--border)`), e entre card e fundo vem de uma diferença sutil de luminosidade (`--surface` vs `--paper`), nunca de `box-shadow`. O único uso de sombra é uma elevação rasa e neutra (nunca colorida) atrás do card de autenticação, para separá-lo do fundo em telas sem outro contexto visual.

### Shadow Vocabulary
- **auth-card** (`box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)`): usado apenas no card de login/registro, que flutua sozinho sobre o fundo sem header.

### Named Rules
**The Flat-By-Default Rule.** Toda superfície dentro do app autenticado (header, cards, listas) é flat; sombra é a exceção reservada ao único elemento que flutua sem contexto.

## Shapes

Cantos discretamente arredondados: 6px em controles pequenos (botão, input, pill de status), 10px em blocos médios (caixa de depósito), 16px no card de autenticação. Sem clipping decorativo, sem recorte diagonal. Bordas são sempre 1px, sólidas, `var(--border)` — nunca dupla, nunca colorida por decoração (a única borda colorida é a borda esquerda dos itens de extrato ao passar o mouse, com verde/vermelho conforme a direção, servindo como afordance funcional de leitura rápida, não decorativa).

## Components

### Buttons
- **Shape:** 6px de raio.
- **Primary:** fundo `--signal-green`, texto `--paper`, padding `10px 20px`, peso 600. É a única superfície verde sólida da tela — usada para no máximo uma ação por tela/seção.
- **Hover/Focus:** hover escurece para `--signal-green-strong`; foco usa `outline: 2px solid var(--signal-green)` com `outline-offset: 2px`, nunca só mudança de cor de borda.
- **Secondary/Ghost:** fundo transparente, borda 1px `--border`, texto `--ink`; usada para ações não-primárias (ex. "Ver extrato" ao lado de "Nova transferência").

### Cards / Containers
- **Corner Style:** 10–16px conforme o bloco (ver Shapes).
- **Background:** `--surface` sobre `--paper`.
- **Shadow Strategy:** nenhuma, exceto o card de autenticação (ver Elevation).
- **Border:** 1px `--border` quando o card não tem separação de fundo suficiente (ex. caixa de depósito usa borda superior em vez de fundo).
- **Internal Padding:** 24px.

### Inputs / Fields
- **Style:** fundo `--paper`, borda 1px `--border`, raio 6px, padding `10px 12px`, texto no peso body.
- **Focus:** borda muda para `--signal-green` + `outline: 2px solid var(--signal-green-tint)`-like halo suave (usar `box-shadow: 0 0 0 3px var(--signal-green-tint)`), nunca glow neon.
- **Error:** borda `--signal-red`, mensagem de erro abaixo em `--signal-red` com ícone de alerta desenhado (não emoji).

### Navigation
- Header horizontal, link de texto no peso body; item ativo ganha peso 600 e uma sublinha de 2px em `--signal-green` (não cor de texto trocada sozinha, para não depender só de cor). Hover sutil (fundo `--surface`). Em mobile, os links colapsam para ícones desenhados com `aria-label`.

### Status Pill (Transação)
- Pequeno rótulo com ponto indicador + texto: `--signal-amber` (pendente), `--signal-green` (concluída), `--signal-red` (falhou). Fundo levemente tintado (`--signal-*-tint`) e raio 6px — não é decoração substituindo conteúdo, é o único indicador de status da tela.

### Direction Arrow (Extrato)
- Seta desenhada (SVG, não glifo unicode) apontando para cima em verde (entrada) ou para baixo em vermelho (saída), ao lado do valor em mono.

### Theme Toggle
- Botão ícone único no header (sol/lua desenhados em SVG, um traço consistente), alterna `data-theme` e persiste em `localStorage`; primeira visita respeita `prefers-color-scheme`.

## Do's and Don'ts

### Do:
- **Do** manter verde como a única cor de marca/ação e vermelho como puramente semântico (saída/erro).
- **Do** usar mono só para números e identificadores exatos.
- **Do** manter o app autenticado inteiramente flat (bordas de 1px, sem sombra).
- **Do** desenhar todo ícone como SVG de traço único e consistente (setas, sol/lua, alerta).

### Don't:
- **Don't** introduzir roxo, gradiente ou qualquer cor fora da paleta definida.
- **Don't** usar sombra colorida, glow ou `border-left` decorativo fora da afordance funcional do extrato.
- **Don't** usar emoji ou glifo unicode como ícone.
- **Don't** usar mono como "estética técnica" fora de números/ids reais.
