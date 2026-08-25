# Tema claro unificado no aplicativo desktop

## Objetivo

Alinhar o aplicativo Electron de cozinha ao painel administrativo web, adotando a mesma identidade clara: fundo off-white, superfícies brancas, bordas quentes discretas, texto escuro e âmbar como acento. A mudança é visual; pedidos, polling, impressão, IPC, integrações e configurações não mudam de comportamento.

## Referência visual

O painel web é a fonte de verdade para os tokens-base:

- `--bg: #FAFAF8`
- `--surface` e `--card: #FFFFFF`
- `--border: #EDE9E3`
- `--border-light: #F5F2EE`
- `--text: #1C1917`
- `--text-muted: #78716C`
- `--text-xmuted: #A8A29E`
- `--primary: #D97706`
- `--primary-hover: #B45309`
- `--primary-tint: #FEF3C7`
- `--success: #16A34A`
- `--danger: #DC2626`

O desktop declara esses tokens em `src/index.css`, aplica `color-scheme: light` e usa os papéis semânticos no lugar de cores escuras literais. A marca da capivara e os acentos funcionais continuam preservados.

## Cobertura

As quatro superfícies do renderer serão ajustadas:

1. `src/App.tsx`: janela, barra superior, abas, avisos, filtro de histórico e colunas do Kanban.
2. `src/components/OrderCard.tsx`: cartões de pedido, detalhes, ações e etiqueta de loja.
3. `src/components/Settings.tsx`: seções, campos, toggles, ações e mensagens de erro.
4. `src/components/WhatsappPanel.tsx`: painel lateral, conversas, bolhas, entrada e botões.

Cada substituição usa `var(--...)` ou cores semânticas de estado. Overlays de modal continuam escuros e translúcidos para manter separação visual. Estados operacionais seguem verde, vermelho, azul, roxo e âmbar, com contraste adequado sobre as superfícies claras.

## Limites

- Não alterar `electron/main.ts`, preload, IPC, polling, impressão, armazenamento seguro ou payloads HTTP.
- Não alterar o painel web nem telas públicas.
- Não introduzir modo escuro, seletor de tema ou dependências novas.
- Não publicar release, gerar instalador nem fazer push ao GitHub nesta etapa.

## Verificação

- `npm run typecheck`;
- `npm run build`;
- revisão de classes para remover os fundos e textos escuros do renderer;
- inspeção visual em desenvolvimento, se o ambiente permitir iniciar o Electron sem interferir na sessão do usuário.

## Riscos e cuidados

- `WebkitAppRegion` da barra e do painel de WhatsApp permanece intacto.
- Campos nativos recebem `color-scheme: light` para que select e input não retenham aparência escura.
- A transição troca apenas estilos; nenhum estado React, callback, evento ou chamada a `window.api` será modificado.
