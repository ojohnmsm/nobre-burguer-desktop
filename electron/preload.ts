import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getConfig:         ()                                => ipcRenderer.invoke('get-config'),
  saveConfig:        (cfg: unknown)                   => ipcRenderer.invoke('save-config', cfg),
  getPrinters:       ()                                => ipcRenderer.invoke('get-printers'),
  printOrder:        (order: unknown)                  => ipcRenderer.invoke('print-order', order),
  fetchOrders:       ()                                => ipcRenderer.invoke('fetch-orders'),
  fetchOrderHistory: (opts: unknown)                   => ipcRenderer.invoke('fetch-order-history', opts),
  updateOrderStatus: (id: string, status: string)     => ipcRenderer.invoke('update-order-status', id, status),
  acknowledgeOrder:  (id: string)                      => ipcRenderer.invoke('acknowledge-order', id),
  onPrintError:      (cb: (err: string) => void) => {
    ipcRenderer.on('print-error', (_e, err) => cb(err))
    return () => ipcRenderer.removeAllListeners('print-error')
  },
  getWhatsappStatus:   ()                                          => ipcRenderer.invoke('get-whatsapp-status'),
  getWhatsappMessages: (conversationId: string)                   => ipcRenderer.invoke('get-whatsapp-messages', conversationId),
  sendWhatsappReply:   (conversationId: string, message: string) => ipcRenderer.invoke('send-whatsapp-reply', conversationId, message),
  resumeWhatsappBot:   (conversationId: string)                   => ipcRenderer.invoke('resume-whatsapp-bot', conversationId),
  markWhatsappConversationSeen: (conversationId: string)          => ipcRenderer.invoke('mark-whatsapp-conversation-seen', conversationId),
  getNotificationSounds: () => ipcRenderer.invoke('get-notification-sounds'),
})
