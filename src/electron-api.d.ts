import type { Order, OrderStatus } from './types'

export interface DesktopConfig {
  apiBaseUrl: string
  desktopApiKeyConfigured: boolean
  printerName: string
  autoPrint: string
  autoStart: string
}

export interface NotificationSoundsResponse {
  orderSoundUrl: string | null
  messageSoundUrl: string | null
}

export interface DesktopConfigInput {
  apiBaseUrl?: string
  desktopApiKey?: string
  printerName?: string
  autoPrint?: string
  autoStart?: string
}

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
      updateOrderStatus: (id: string, status: OrderStatus) => Promise<boolean>
      acknowledgeOrder: (id: string) => Promise<boolean>
      onPrintError: (callback: (error: string) => void) => () => void
      getStore: () => Promise<{ storeName: string | null }>
      getWhatsappStatus: () => Promise<WhatsappStatusResponse>
      getWhatsappMessages: (conversationId: string) => Promise<WhatsappMessagesResponse>
      sendWhatsappReply: (conversationId: string, message: string) => Promise<boolean>
      resumeWhatsappBot: (conversationId: string) => Promise<boolean>
      markWhatsappConversationSeen: (conversationId: string) => Promise<boolean>
      getNotificationSounds: () => Promise<NotificationSoundsResponse>
    }
  }
}
