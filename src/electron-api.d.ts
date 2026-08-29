import type { Order, OrderStatus } from './types'

export interface DesktopConfig {
  connections: { id: string; apiBaseUrl: string; label: string }[]
  apiBaseUrl: string
  desktopApiKeyConfigured: boolean
  printerName: string
  /** '58' (32 colunas) ou '80' (48 colunas). */
  printerWidth: string
  autoPrint: string
  autoStart: string
}

export interface NotificationSoundsResponse {
  orderSoundUrl: string | null
  messageSoundUrl: string | null
}

export interface DesktopConfigInput {
  printerName?: string
  printerWidth?: string
  autoPrint?: string
  autoStart?: string
}

export interface IfoodCancelReason {
  code: string
  description: string
}

export interface StorePauseState {
  ok: boolean
  error?: string
  loja?: { aberta: boolean }
  ifood?: {
    conectada: boolean
    pausada: boolean
    pausadaAte: string | null
    recebendo: boolean | null
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
      onPrintError: (callback: (error: string) => void) => () => void
      getStores: () => Promise<{ id: string; storeName: string | null; online: boolean }[]>
      addConnection: (url: string, token: string) => Promise<{ erro?: string }>
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
