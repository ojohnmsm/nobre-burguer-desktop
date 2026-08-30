import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getConfig:         ()                                => ipcRenderer.invoke('get-config'),
  saveConfig:        (cfg: unknown)                   => ipcRenderer.invoke('save-config', cfg),
  getPrinters:       ()                                => ipcRenderer.invoke('get-printers'),
  printOrder:        (order: unknown)                  => ipcRenderer.invoke('print-order', order),
  fetchOrders:       ()                                => ipcRenderer.invoke('fetch-orders'),
  fetchOrderHistory: (opts: unknown)                   => ipcRenderer.invoke('fetch-order-history', opts),
  updateOrderStatus: (id: string, status: string, connectionId?: string) => ipcRenderer.invoke('update-order-status', id, status, connectionId),
  acknowledgeOrder:  (id: string, connectionId?: string) => ipcRenderer.invoke('acknowledge-order', id, connectionId),
  getIfoodCancelReasons: (id: string, connectionId?: string) => ipcRenderer.invoke('get-ifood-cancel-reasons', id, connectionId),
  requestIfoodCancel: (id: string, code: string, description: string, connectionId?: string) => ipcRenderer.invoke('request-ifood-cancel', id, code, description, connectionId),
  getStorePauseState: (connectionId?: string) => ipcRenderer.invoke('get-store-pause-state', connectionId),
  setStorePause: (body: unknown, connectionId?: string) => ipcRenderer.invoke('set-store-pause', body, connectionId),
  getIfoodDisputes: () => ipcRenderer.invoke('get-ifood-disputes'),
  respondIfoodDispute: (disputeId: string, resposta: 'accept' | 'reject', motivo: string | null, connectionId?: string) =>
    ipcRenderer.invoke('respond-ifood-dispute', disputeId, resposta, motivo, connectionId),
  onPrintError:      (cb: (err: string) => void) => {
    ipcRenderer.on('print-error', (_e, err) => cb(err))
    return () => ipcRenderer.removeAllListeners('print-error')
  },
  onNewOrder: (cb: (info: { id: string; label: string; canal: string; customerName: string; isPickup: boolean }) => void) => {
    const listener = (_e: unknown, info: { id: string; label: string; canal: string; customerName: string; isPickup: boolean }) => cb(info)
    ipcRenderer.on('novo-pedido', listener)
    return () => ipcRenderer.removeListener('novo-pedido', listener)
  },
  getStores:           ()                                          => ipcRenderer.invoke('get-stores'),
  addConnection:       (url: string, token: string)                 => ipcRenderer.invoke('add-connection', url, token),
  removeConnection:    (id: string)                                 => ipcRenderer.invoke('remove-connection', id),
  getWhatsappStatus:   ()                                          => ipcRenderer.invoke('get-whatsapp-status'),
  getWhatsappMessages: (conversationId: string)                   => ipcRenderer.invoke('get-whatsapp-messages', conversationId),
  sendWhatsappReply:   (conversationId: string, message: string) => ipcRenderer.invoke('send-whatsapp-reply', conversationId, message),
  resumeWhatsappBot:   (conversationId: string)                   => ipcRenderer.invoke('resume-whatsapp-bot', conversationId),
  markWhatsappConversationSeen: (conversationId: string)          => ipcRenderer.invoke('mark-whatsapp-conversation-seen', conversationId),
  getNotificationSounds: () => ipcRenderer.invoke('get-notification-sounds'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window-maximized-changed', listener)
    return () => ipcRenderer.removeListener('window-maximized-changed', listener)
  },
})
