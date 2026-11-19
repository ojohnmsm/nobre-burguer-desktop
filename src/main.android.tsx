import React from 'react'
import ReactDOM from 'react-dom/client'
import { instalarApiAndroid } from './android/api'
import './index.css'

/**
 * Entrada do app Android (o desktop usa main.tsx).
 *
 * A interface é a mesma. O que muda é quem atende `window.api`: lá é o preload
 * do Electron, aqui é src/android/api.ts — e ele precisa existir antes de
 * qualquer componente montar, por isso o App só é importado depois.
 */
async function iniciar() {
  // Gancho para o CSS de toque do tablet (alvos maiores, sem hover).
  document.documentElement.classList.add('plataforma-android')
  await instalarApiAndroid()
  const { default: App } = await import('./App')

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void iniciar()
