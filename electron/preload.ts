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
    // removeListener com a referência, não removeAllListeners — aquele
    // apagaria também um segundo assinante deste canal que viesse a existir,
    // não só este. Mesmo padrão que onNewOrder já usa corretamente ao lado.
    const listener = (_e: unknown, err: string) => cb(err)
    ipcRenderer.on('print-error', listener)
    return () => ipcRenderer.removeListener('print-error', listener)
  },
  onNewOrder: (cb: (info: { id: string; label: string; canal: string; customerName: string; isPickup: boolean }) => void) => {
    const listener = (_e: unknown, info: { id: string; label: string; canal: string; customerName: string; isPickup: boolean }) => cb(info)
    ipcRenderer.on('novo-pedido', listener)
    return () => ipcRenderer.removeListener('novo-pedido', listener)
  },
  onOrdersUpdated: (cb: (orders: unknown[]) => void) => {
    const listener = (_e: unknown, orders: unknown[]) => cb(orders)
    ipcRenderer.on('pedidos-atualizados', listener)
    return () => ipcRenderer.removeListener('pedidos-atualizados', listener)
  },
  getStores:           ()                                          => ipcRenderer.invoke('get-stores'),
  addConnection:       (url: string, token: string)                 => ipcRenderer.invoke('add-connection', url, token),
  pairDevice:          (url: string, code: string)                  => ipcRenderer.invoke('pair-device', url, code),
  removeConnection:    (id: string)                                 => ipcRenderer.invoke('remove-connection', id),
  getWhatsappStatus:   ()                                          => ipcRenderer.invoke('get-whatsapp-status'),
  getWhatsappMessages: (conversationId: string, connectionId?: string) => ipcRenderer.invoke('get-whatsapp-messages', conversationId, connectionId),
  sendWhatsappReply:   (conversationId: string, message: string, connectionId?: string) => ipcRenderer.invoke('send-whatsapp-reply', conversationId, message, connectionId),
  resumeWhatsappBot:   (conversationId: string, connectionId?: string) => ipcRenderer.invoke('resume-whatsapp-bot', conversationId, connectionId),
  markWhatsappConversationSeen: (conversationId: string, connectionId?: string) => ipcRenderer.invoke('mark-whatsapp-conversation-seen', conversationId, connectionId),
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
