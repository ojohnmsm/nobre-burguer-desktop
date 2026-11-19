import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

/**
 * Build da interface para o app Android (Capacitor).
 *
 * É o MESMO código de src/ que o electron-vite empacota para o desktop, com
 * duas diferenças: a entrada é main.android.tsx (que instala o `window.api` do
 * tablet antes de montar a tela) e a saída vai para dist-android/, que o
 * Capacitor copia para dentro do projeto em android/.
 */

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

function entradaAndroid(): Plugin {
  return {
    name: 'cardapia-entrada-android',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace('src="/main.tsx"', 'src="/main.android.tsx"')
          // A ponte do Capacitor é injetada pela WebView como script embutido
          // em aparelhos com WebView antiga; o `script-src 'self'` estrito do
          // desktop deixaria a tela em branco neles. O conteúdo continua sendo
          // só o que vai dentro do APK.
          .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      },
    },
  }
}

export default defineConfig({
  root: 'src',
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), entradaAndroid()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: resolve(__dirname, 'dist-android'),
    emptyOutDir: true,
  },
})
