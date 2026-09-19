# Opção local para concluir pedidos pelo scanner

## Objetivo

Tornar a conclusão por QR uma capacidade opcional de cada computador. Lojas que não usam leitor não devem imprimir o QR nem ter rajadas de teclado interpretadas como comandas.

## Comportamento

- A configuração `scannerReady` pertence ao computador e vale para todas as lojas conectadas nele.
- O padrão é `false`, inclusive quando uma instalação anterior ainda não possui esse campo.
- Com a opção desligada, a comanda não imprime QR e o renderer não registra o listener do scanner.
- Com a opção ligada, todas as comandas impressas nesse computador recebem o QR e o leitor pode concluir pedidos de qualquer loja conectada.
- O botão de teste acompanha a configuração: com scanner ligado imprime e valida o QR; desligado testa somente a comanda.
- A mudança entra em vigor após salvar as configurações.

## Verificação

- Validar o padrão desligado e a persistência dos dois estados.
- Validar comanda com e sem QR.
- Validar que o listener recebe `enabled: false` até a opção ser salva como ligada.
- Rodar typecheck e build, publicar e instalar a versão 1.1.25.
