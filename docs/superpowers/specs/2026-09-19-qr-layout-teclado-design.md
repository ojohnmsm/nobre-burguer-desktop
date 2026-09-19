# QR de comanda independente do layout do teclado

## Problema

O QR atual contém `PEDIDO:<uuid>`. Leitores HID configurados como teclado americano enviam a tecla física de `:`, mas o Windows com layout ABNT2 pode interpretá-la como `Ç`. O desktop recebe `PEDIDOÇ<uuid>` e rejeita uma comanda válida.

## Solução

- Novas comandas usarão `PEDIDO<uuid>`, sem separador dependente do layout.
- O leitor aceitará o formato novo e os formatos legados `PEDIDO:<uuid>`, `PEDIDOÇ<uuid>`, `PEDIDOç<uuid>` e `PEDIDO;<uuid>`.
- Depois de remover somente um separador legado conhecido, o conteúdo continuará obrigado a ser `TESTE` ou um UUID válido.
- A validação do pedido, da loja e do estado continuará no backend; a tolerância ao layout não amplia a autorização.

## Verificação

- Testar a extração do UUID em todos os formatos aceitos.
- Confirmar a rejeição de prefixo aleatório, UUID inválido e separadores desconhecidos.
- Rodar typecheck e build do desktop.
- Gerar e inspecionar uma comanda para confirmar o novo payload sem pontuação.
- Publicar e instalar a versão 1.1.24.
