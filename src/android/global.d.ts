/**
 * `window.cardapiaAndroid` — só existe no app Android (instalado por
 * src/android/api.ts quando roda dentro do Capacitor). No Electron e no
 * navegador fica `undefined`: quem usa confere antes (`window.cardapiaAndroid?.`).
 *
 * É o que a tela precisa do tablet que não faz sentido no PC: permissões do
 * Android, bateria, tela cheia, Bluetooth e o vigia nativo de pedidos.
 */

/** Motivo de a lista de impressoras Bluetooth não vir (código do plugin nativo). */
export type MotivoSemImpressoras = 'SEM_PERMISSAO' | 'BLUETOOTH_DESLIGADO'

export interface SaudeDoBalcao {
  /** O vigia nativo existe neste build (false = recuo para o vigia em JavaScript). */
  nativo: boolean
  /** Notificações do app permitidas no Android. */
  notificacoes: boolean
  /** Fora da otimização de bateria (o Android não segura o vigia). */
  isentoBateria: boolean
  /** Pode usar notificação de tela cheia — é o que acende a tela no pedido novo. */
  podeTelaCheia: boolean
  /** O serviço de pedidos está rodando agora. */
  vigiaRodando: boolean
  /** Há loja pareada (sem ela o serviço não sobe, e não é defeito). */
  lojaPareada: boolean
  bluetoothExiste: boolean
  bluetoothLigado: boolean
  /** Permissão "dispositivos próximos" (Android 12+). */
  bluetoothPermitido: boolean
  /** Preferência "Manter a tela ligada" (padrão: ligada). */
  telaLigada: boolean
}

export interface CardapiaAndroidApi {
  /** Retrato de tudo que o bloco "Saúde do balcão" mostra. Nunca lança. */
  saudeDoBalcao(): Promise<SaudeDoBalcao>
  /** Pede a permissão de notificação (Android 13+). Devolve se ficou permitida. */
  pedirPermissaoNotificacao(): Promise<boolean>
  /** Abre o pedido do sistema para tirar o app da otimização de bateria. */
  pedirIsencaoBateria(): Promise<void>
  /** Abre o ajuste "notificações em tela cheia" deste app (Android 14+). */
  abrirAjusteTelaCheia(): Promise<void>
  /** Abre a página do app nos ajustes do Android (permissões negadas de vez). */
  abrirAjustesDoApp(): Promise<void>
  /** Pede "dispositivos próximos". Devolve se ficou permitido. */
  pedirPermissaoBluetooth(): Promise<boolean>
  /** Liga/desliga o "manter a tela ligada" (grava no nativo; vale já e nas próximas aberturas). */
  manterTelaLigada(ligar: boolean): Promise<void>
  /** Reenvia a config ao vigia nativo e o liga de novo. */
  reiniciarVigia(): Promise<void>
  /**
   * Lê o motivo de um erro de `window.api.getPrinters()`. O erro rejeitado tem
   * `code` e uma `message` em português pronta para a tela; isto só tipa o code.
   */
  motivoSemImpressoras(erro: unknown): MotivoSemImpressoras | null
}

declare global {
  interface Window {
    cardapiaAndroid?: CardapiaAndroidApi
  }
}
