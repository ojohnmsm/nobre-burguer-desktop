# Publicar uma versão

O instalador é do Windows, e o `.exe` só pode ser gerado **numa máquina
Windows**. O servidor onde o resto do sistema roda é Linux e não tem wine —
publicar de lá produziria `AppImage` e `snap`, sem instalador nenhum, e o botão
de download do painel quebraria por não achar `.exe`.

## Passos

1. Puxe a branch com as mudanças e faça o merge em `main`.

2. Confirme a versão em `package.json`. Ela precisa ser **maior** que a
   publicada, senão o electron-builder recusa — hoje está em `1.1.0`.

3. Crie um arquivo `.env.local` na raiz deste repositório com o token do
   GitHub que tem permissão de publicar release:

   ```
   GH_TOKEN=...
   ```

   O arquivo está no `.gitignore` e não vai para o repositório.

4. Publique:

   ```
   npm install
   npm run release
   ```

## O que conferir depois

A versão nova em `releases/latest` precisa ter:

- `Cardapia-Setup-1.1.0.exe` — é o que o botão de download entrega
- `latest.yml` — é o que a atualização automática lê

Se sair `Cardapia-1.1.0.AppImage` em vez do `.exe`, a construção rodou em Linux.

## Atenção nesta versão

O `appId` mudou de `com.nobreburguer.desktop` para `shop.cardapia.desktop`.
Para o sistema operacional isso é **outro programa**: quem tem o "Nobre Burguer"
instalado não recebe esta atualização sozinho. Precisa desinstalar o antigo e
instalar o Cardapia — uma vez só, e nunca mais.

## Se o aplicativo sair com o ícone do Electron

Confira `build.win` no `package.json`. Com `signAndEditExecutable: false` o
electron-builder pula a **edição de recursos do executável**, e é aí que o ícone
e os metadados são gravados — o resultado é o átomo padrão do Electron mesmo
com `build/icon.png` no lugar certo.

O correto para pular só a assinatura digital é `signExecutable: false`. A
própria saída da construção avisa isso, na linha que começa com
"executable resource editing and code signing skipped".
