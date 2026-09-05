import type { Order, OrderStatus } from './types'

export interface DesktopConfig {
  connections: { id: string; apiBaseUrl: string; label: string }[]
  apiBaseUrl: string
  desktopApiKeyConfigured: boolean
  printerName: string
  /** '58' (32 colunas) ou '80' (48 colunas). */
  printerWidth: string
  autoPrint: string
  /** 'all' | 'own' | 'ifood' — quais canais a impressão automática imprime. */
  autoPrintChannels: string
  /** Vias impressas por pedido novo: '1' a '3'. */
  printCopies: string
  autoStart: string
}

export interface NotificationSoundsResponse {
  orderSoundUrl: string | null
  messageSoundUrl: string | null
  driverSoundUrl: string | null
}

export interface DesktopConfigInput {
  printerName?: string
  printerWidth?: string
  autoPrint?: string
  autoPrintChannels?: string
  printCopies?: string
  autoStart?: string
}

export interface IfoodCancelReason {
  code: string
  description: string
}

export interface IfoodDispute {
  id: string
  disputeId: string
  ifoodOrderId: string | null
  displayId: string | null
  action: string | null
  timeoutAction: string | null
  expiresAt: string | null
  message: string | null
  handshakeType: string | null
  refundMaxCents: number | null
  connectionId?: string
  storeLabel?: string
}

export interface StorePauseState {
  ok: boolean
  error?: string
  loja?: {
    /** Efetivo: chave geral ligada E dentro do horário. */
    aberta: boolean
    /** A chave geral (is_open_override). */
    overrideAtivo: boolean
    /** O relógio: está dentro de uma janela de funcionamento agora. */
    dentroDoHorario: boolean
  }
  ifood?: {
    conectada: boolean
    pausada: boolean
    pausadaAte: string | null
    recebendo: boolean | null
    /** Motivo de o iFood não estar recebendo (ex.: "Fora do horário"), quando há. */
    motivo: string | null
  }
}

export type UpdateStatusResult =
  | { ok: true; requested: boolean; message: string | null }
  | { ok: false; error: string }

export interface PrinterInfo {
  name: string
  displayName: string
}

export type WhatsappConversationStatus = 'bot_active' | 'human_active' | 'awaiting_human' | 'closed'

export interface WhatsappStatusConversation {
  id: string
  phone: string
  status: 'awaiting_human' | 'human_active'
  handoffReason: string | null
  orderId: string | null
  updatedAt: string
  lastMessage: { role: string; content: string | null; createdAt: string } | null
  lastSeenAt: string | null
}

export interface WhatsappStatusResponse {
  conversations: WhatsappStatusConversation[]
  connectionState: string
}

export interface WhatsappConversationDetail {
  id: string
  phone: string
  status: WhatsappConversationStatus
  handoff_reason: string | null
  order_id: string | null
  created_at: string
  updated_at: string
}

export interface WhatsappMessage {
  id: string
  conversation_id: string
  direction: 'inbound' | 'outbound'
  role: 'customer' | 'assistant' | 'tool' | 'human_agent'
  content: string | null
  created_at: string
}

export interface WhatsappMessagesResponse {
  conversation: WhatsappConversationDetail
  messages: WhatsappMessage[]
}

declare global {
  interface Window {
    api: {
      getConfig: () => Promise<DesktopConfig>
      saveConfig: (config: DesktopConfigInput) => Promise<boolean>
      getPrinters: () => Promise<PrinterInfo[]>
      printOrder: (order: Order) => Promise<'ok' | 'no-printer' | 'error'>
      fetchOrders: () => Promise<Order[]>
      fetchOrderHistory: (opts: { limit: number; offset: number; status?: OrderStatus | '' }) => Promise<Order[]>
      updateOrderStatus: (id: string, status: OrderStatus, connectionId?: string) => Promise<UpdateStatusResult>
      acknowledgeOrder: (id: string, connectionId?: string) => Promise<boolean>
      getIfoodCancelReasons: (id: string, connectionId?: string) => Promise<{ ok: boolean; reasons?: IfoodCancelReason[]; error?: string }>
      requestIfoodCancel: (id: string, code: string, description: string, connectionId?: string) => Promise<{ ok: boolean; error?: string }>
      getStorePauseState: (connectionId?: string) => Promise<StorePauseState>
      setStorePause: (body: { alvo: 'loja' | 'ifood'; acao: 'pausar' | 'retomar'; minutos?: number }, connectionId?: string) => Promise<{ ok: boolean; error?: string }>
      getIfoodDisputes: () => Promise<{ disputas: IfoodDispute[] }>
      respondIfoodDispute: (disputeId: string, resposta: 'accept' | 'reject', motivo: string | null, connectionId?: string) => Promise<{ ok: boolean; error?: string }>
      onPrintError: (callback: (error: string) => void) => () => void
      onNewOrder: (callback: (info: { id: string; label: string; canal: string; customerName: string; isPickup: boolean }) => void) => () => void
      /** Lista completa e pronta de pedidos, empurrada pelo processo principal — não é mais o renderer quem busca. */
      onOrdersUpdated: (callback: (orders: Order[]) => void) => () => void
      getStores: () => Promise<{ id: string; storeName: string | null; online: boolean; ifoodConectado: boolean; ifoodPollingParadoSegundos: number | null }[]>
      addConnection: (url: string, token: string) => Promise<{ erro?: string }>
      /** Troca o código curto de pareamento pelo token longo e liga a loja. */
      pairDevice: (url: string, code: string) => Promise<{ erro?: string; storeName?: string | null }>
      removeConnection: (id: string) => Promise<{ ok: boolean }>
      getWhatsappStatus: () => Promise<WhatsappStatusResponse>
      getWhatsappMessages: (conversationId: string) => Promise<WhatsappMessagesResponse>
      sendWhatsappReply: (conversationId: string, message: string) => Promise<boolean>
      resumeWhatsappBot: (conversationId: string) => Promise<boolean>
      markWhatsappConversationSeen: (conversationId: string) => Promise<boolean>
      getNotificationSounds: () => Promise<NotificationSoundsResponse>
      minimizeWindow: () => Promise<void>
      toggleMaximizeWindow: () => Promise<boolean>
      isWindowMaximized: () => Promise<boolean>
      closeWindow: () => Promise<void>
      onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void
    }
  }
}
