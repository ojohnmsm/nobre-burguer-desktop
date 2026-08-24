# Recursos de construção

O electron-builder procura o ícone do aplicativo **nesta pasta**, pelo nome.
Ela existia só implicitamente: sem `directories.buildResources` no
`package.json`, o padrão é `build/` — e como a pasta não estava no repositório,
não havia onde colocar o ícone nem pista de que ela era esperada.

## O ícone

Coloque aqui um arquivo chamado exatamente:

```
icon.png
```

Requisitos:

- **1024×1024** (o mínimo que o electron-builder aceita para gerar os demais
  tamanhos é 256×256, mas partir de 1024 evita o ícone ficar borrado no
  instalador e na barra de tarefas)
- PNG com **fundo transparente**
- Quadrado. Imagem retangular é recusada na construção.

É a capivara da Cardapia. O mesmo desenho vive em `src/components/CapivaraMark.tsx`
como vetor, para a interface; aqui é preciso um arquivo de imagem porque o
instalador e o sistema operacional não leem SVG.

Não é preciso mexer em configuração: basta o arquivo existir com esse nome. Sem
ele, o aplicativo sai com o ícone padrão do Electron — que é o comportamento
atual.
