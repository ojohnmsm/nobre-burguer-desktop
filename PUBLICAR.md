# Publicar uma versão

A publicação é automática: empurrar uma tag `v*` faz o GitHub construir o
instalador do Windows e anexá-lo à release.

```
git tag v1.1.2
git push origin v1.1.2
```

Acompanhe em **Actions**. Ao final, a release aparece em Releases com o `.exe`,
o `.blockmap` e o `latest.yml`.

O passo final do fluxo CONFERE três coisas: que existe **uma só** release para
a tag, que o `.exe` subiu e que o `latest.yml` subiu. Falha se qualquer uma
faltar. Sem o `latest.yml` o electron-updater não enxerga a versão nova —
a release parece publicada e não atualiza ninguém. É uma falha silenciosa, e por
isso vale um teste explícito.

## Se aparecerem duas releases com a mesma tag

Não deve mais acontecer — a release passou a ser criada antes da construção,
justamente para não haver o que disputar. Se acontecer, apague as duas e empurre
a tag de novo: com os arquivos divididos entre elas, o atualizador lê a que o
GitHub escolher, e pode ser a que não tem o `latest.yml`.

## Por que não publicar da própria máquina

O `npm run release` continua funcionando e é útil para experimentar. Mas subir
95 MB por conexão doméstica falhou em duas das três primeiras tentativas, cada
vez deixando um arquivo diferente para trás. Na nuvem, quem constrói e quem
hospeda são a mesma infraestrutura.

## Antes de marcar a versão

A versão em `package.json` precisa ser **maior** que a publicada, e a tag deve
corresponder a ela.

## Atenção ao appId

O `appId` mudou de `com.nobreburguer.desktop` para `shop.cardapia.desktop` na
1.1.0. Para o sistema operacional isso é outro programa: quem tinha o
"Nobre Burguer" instalado precisou desinstalar e instalar o Cardapia. De 1.1.0
em diante a atualização é automática.

## Se o aplicativo sair com o ícone do Electron

Confira `build.win` no `package.json`. Com `signAndEditExecutable: false` o
electron-builder pula a **edição de recursos do executável**, e é aí que o ícone
e os metadados são gravados. O correto para pular só a assinatura digital é
`signExecutable: false`.
