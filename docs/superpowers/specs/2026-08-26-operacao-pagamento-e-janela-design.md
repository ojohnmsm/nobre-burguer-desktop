# Operação somente após pagamento e janela personalizada

## Objetivo

Impedir que pedidos ainda aguardando a confirmação do gateway cheguem à
operação da cozinha e substituir a moldura nativa com menu legado do desktop
por uma janela alinhada à identidade visual clara do Cardapia.

## Regra operacional

- `awaiting_payment` significa que o pagamento online ainda não foi
  confirmado, independentemente de o cliente ter escolhido Pix ou cartão de
  crédito no aplicativo.
- Esse status não aparece no Kanban operacional, não incrementa badges de
  pedido novo, não dispara som e não dispara impressão automática.
- O pedido passa a ser operacional somente quando a confirmação do gateway o
  atualiza para `paid`; a partir daí aparece, notifica e pode ser impresso.
- A API web já exclui esse status na consulta ativa. Web e desktop repetirão a
  proteção no cliente para que uma resposta antiga, cacheada ou incorreta não
  cause trabalho na cozinha.

## Janela desktop

- A janela Electron será sem moldura nativa (`frame: false`) e sem o menu
  `File / Edit / View / Window`.
- O cabeçalho React existente passa a ser a barra de título: área central de
  arrastar, identidade Cardapia à esquerda e controles próprios de minimizar,
  maximizar/restaurar e fechar à direita.
- Os controles não ganham acesso a Node no renderer. Cada ação passa por um
  IPC mínimo, explicitamente exposto pelo preload.
- A bandeja do sistema usará o ícone oficial existente, carregado como imagem
  raster e dimensionado para o Windows em vez do SVG improvisado atual.

## Limites

- Não altera criação, pagamento, impressão manual, autenticação, dados de
  lojas ou o contrato com o gateway.
- Não exibe o pedido antes de `paid`; a confirmação do gateway continua sendo
  a única transição que libera a cozinha.
- Nenhuma credencial sai do processo principal do Electron.

## Verificação

- Desktop: `npm run typecheck` e `npm run build`.
- Web: `npm run lint`, `npm run typecheck` e `npm run build`.
- Revisão estática da lista, badge, alerta sonoro, impressão automática e
  Kanban para garantir que todos usam a mesma elegibilidade operacional.
