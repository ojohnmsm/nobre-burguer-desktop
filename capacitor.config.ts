import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // Outro id que o do desktop (shop.cardapia.desktop): para a loja de apps e
  // para o Android são programas diferentes.
  appId: 'shop.cardapia.pedidos',
  appName: 'Cardapia',
  webDir: 'dist-android',
  android: {
    // Depuração da WebView (chrome://inspect) DE PROPÓSITO sem valor fixo: sem
    // a chave, o Capacitor liga só quando o APK é debuggable (build de debug) e
    // desliga no de release (CapConfig.java lê FLAG_DEBUGGABLE). Este arquivo é
    // lido no `cap sync`, não no build do Gradle — um valor fixo aqui valeria
    // para os dois tipos de build. Não ponha `true`: no APK de release isso
    // deixaria qualquer um com cabo USB ler o token da loja pela WebView.
    // webContentsDebuggingEnabled: (deixado de fora de propósito)
  },
}

export default config
