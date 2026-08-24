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

4. Publique. Dois comandos, um de cada vez:

   ```
   npm install
   ```

   ```
   npm run release
   ```

   No PowerShell do Windows não junte os dois com `&&` — ele só aceita esse
   operador a partir da versão 7, e a que vem no Windows é a 5. Também não use
   `;` no lugar: ele roda o segundo comando mesmo se o primeiro falhar, e você
   publicaria com as dependências pela metade.

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
