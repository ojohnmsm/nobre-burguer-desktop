import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/main',
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      emptyOutDir: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      emptyOutDir: true,
    },
  },
  renderer: {
    root: 'src',
    build: {
      outDir: 'dist',
      rollupOptions: { input: { index: resolve(__dirname, 'src/index.html') } },
    },
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
  },
})
