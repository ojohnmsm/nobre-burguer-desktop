# Kanban compacto do aplicativo da cozinha

## Objetivo

Fazer o kanban do aplicativo desktop reproduzir a linguagem operacional aprovada para Pedidos no painel web: cinco etapas, cartões densos e uma ação principal acessível sem abrir o pedido.

## Estrutura

- Manter as cinco colunas, as etapas, a ordenação por urgência e o polling/IPC existentes.
- Trocar as divisórias contínuas por colunas individuais, com borda superior na cor da etapa, contador e área de fila neutra.
- Reduzir o cartão fechado para número, relógio, canal, modalidade, cliente e alertas essenciais.
- Exibir o botão da próxima transição no cartão fechado. O botão avança apenas para `proximaEtapa(order)`; o restante do cartão abre os detalhes.
- Preservar impressão, cancelamento, código de coleta, endereço, observações e itens no estado expandido.

## Limites e segurança

O desktop continua a usar apenas sua API preload/IPC. Não compartilha componentes com o painel web. Nenhum fluxo de status, alerta sonoro, impressão, multi-loja ou otimização de marketplace será alterado.

## Validação

Rodar `npm run typecheck` e `npm run build` no repositório desktop. Conferir visualmente as colunas, o avanço visível e a abertura de detalhes sem acionar a transição.
