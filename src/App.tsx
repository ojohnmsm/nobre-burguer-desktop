import { useCallback, useEffect, useRef, useState } from 'react'
import { History, LayoutGrid, MessageCircle, Printer, RefreshCw, Settings as SettingsIcon, WifiOff } from 'lucide-react'
import { OrderCard } from './components/OrderCard'
import { Settings } from './components/Settings'
import { WhatsappPanel } from './components/WhatsappPanel'
import { CapivaraMark } from './components/CapivaraMark'
import { KANBAN_COLUMNS, STATUS_LABELS, type Order, type OrderStatus } from './types'
import type { WhatsappStatusConversation } from './electron-api'
import { loadNotificationSounds, playMessageAlert, playOrderAlert } from './notification-sound'

type Tab = 'kanban' | 'historico' | 'whatsapp' | 'settings'
const ALL_STATUSES: OrderStatus[] = [
  'pending', 'awaiting_payment', 'paid', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'
]
const HISTORY_PAGE_SIZE = 30

export default function App() {
  const [tab, setTab] = useState<Tab>('kanban')
  const [stores, setStores] = useState<{ id: string; storeName: string | null; online: boolean }[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [autoPrint, setAutoPrint] = useState(true)
  const [notifications, setNotifications] = useState<string[]>([])
  const [configured, setConfigured] = useState(false)

  const notificationTimerRef = useRef<number | null>(null)
  const knownOrderIdsRef = useRef<Set<string>>(new Set())
  const hasLoadedOrdersRef = useRef(false)
  const autoPrintRef = useRef(true)
  const orderSoundIntervalRef = useRef<number | null>(null)
  const messageSoundIntervalRef = useRef<number | null>(null)

  // ── Pedidos novos não vistos (abrir o card reconhece) ──────────────────────
  // O "visto" é persistido no banco (orders.acknowledged_at) via API em vez
  // de ficar só em memória local — assim o alerta sincroniza entre todos os
  // dispositivos (esse app rodando em vários PCs + o admin web) e sobrevive
  // a reload/restart, já que a fonte de verdade não é mais o estado de uma
  // instância específica.
  const unacknowledgedOrders = orders.filter(order => !order.acknowledged_at && order.status !== 'delivered' && order.status !== 'cancelled')

  function ackOrder(orderId: string) {
    setOrders(previous => previous.map(order =>
      order.id === orderId && !order.acknowledged_at
        ? { ...order, acknowledged_at: new Date().toISOString() }
        : order
    ))
    void window.api.acknowledgeOrder(orderId, orders.find(o => o.id === orderId)?.connectionId)
  }

  const addNotification = useCallback((message: string) => {
    setNotifications(previous => [message, ...previous].slice(0, 5))
    if (notificationTimerRef.current) window.clearTimeout(notificationTimerRef.current)
    notificationTimerRef.current = window.setTimeout(() => setNotifications([]), 6000)
  }, [])

  const loadOrders = useCallback(async () => {
    if (!hasLoadedOrdersRef.current) setLoading(true)

    try {
      const data = await window.api.fetchOrders()
      const newOrders = hasLoadedOrdersRef.current
        ? data.filter(order => !knownOrderIdsRef.current.has(order.id))
        : []

      setOrders(data)
      knownOrderIdsRef.current = new Set(data.map(order => order.id))
      hasLoadedOrdersRef.current = true

      for (const order of newOrders) {
        const isPickup = order.fulfillment_type === 'pickup'
        const viaWhatsapp = order.channel === 'whatsapp'
        addNotification(`${isPickup ? 'RETIRADA — ' : ''}${viaWhatsapp ? 'WhatsApp — ' : ''}Novo pedido #${order.id.slice(0, 8).toUpperCase()} — ${order.customer_name}`)
        if (autoPrintRef.current) {
          const result = await window.api.printOrder(order)
          if (result === 'no-printer') addNotification('Configure uma impressora para ativar a impressão automática')
        }
      }
    } catch {
      if (!hasLoadedOrdersRef.current) setOrders([])
      addNotification('Não foi possível atualizar os pedidos')
    } finally {
      setLoading(false)
    }
  }, [addNotification])

  const readConfig = useCallback(async () => {
    const config = await window.api.getConfig()
    // Pergunta à lista, não aos campos de compatibilidade: é a lista que
    // manda desde que o computador pode atender mais de uma loja.
    const ready = config.connections.length > 0
    setConfigured(ready)
    setAutoPrint(config.autoPrint !== 'false')
    autoPrintRef.current = config.autoPrint !== 'false'

    // Os nomes das lojas vêm junto: sem servidor configurado não há a quem
    // perguntar, e com ele configurado a resposta muda se o código for trocado.
    if (ready) {
      const lista = await window.api.getStores().catch(() => [])
      setStores(lista)
    } else {
      setStores([])
    }

    return ready
  }, [])

  useEffect(() => {
    let active = true
    void readConfig().then(ready => {
      if (active && ready) void loadOrders()
      if (active && !ready) setLoading(false)
    })

    const unsubscribeError = window.api.onPrintError(error => addNotification(`Erro de impressão: ${error}`))
    return () => {
      active = false
      unsubscribeError()
      if (notificationTimerRef.current) window.clearTimeout(notificationTimerRef.current)
    }
  }, [addNotification, loadOrders, readConfig])

  useEffect(() => {
    if (!configured) return
    const interval = window.setInterval(() => { void loadOrders() }, 10000)
    return () => window.clearInterval(interval)
  }, [configured, loadOrders])

  useEffect(() => {
    void loadNotificationSounds()
  }, [])

  // ── Histórico (pedidos com mais de 24h, fora do Kanban operacional) ────────
  const [historyOrders, setHistoryOrders] = useState<Order[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyStatusFilter, setHistoryStatusFilter] = useState<OrderStatus | ''>('')
  const [historyHasMore, setHistoryHasMore] = useState(true)

  const loadHistory = useCallback(async (reset: boolean) => {
    reset ? setHistoryLoading(true) : setHistoryLoadingMore(true)
    try {
      const offset = reset ? 0 : historyOrders.length
      const fetched = await window.api.fetchOrderHistory({ limit: HISTORY_PAGE_SIZE, offset, status: historyStatusFilter })
      setHistoryOrders(previous => reset ? fetched : [...previous, ...fetched])
      setHistoryHasMore(fetched.length === HISTORY_PAGE_SIZE)
    } catch {
      addNotification('Não foi possível carregar o histórico')
    } finally {
      setHistoryLoading(false)
      setHistoryLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyStatusFilter])

  useEffect(() => {
    if (tab === 'historico' && configured) void loadHistory(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, configured, historyStatusFilter])

  // ── WhatsApp (mesma cobertura do painel web: lista persistente + chat) ────
  // "Visto" é persistido no banco via IPC em vez de ficar só em memória
  // local — senão o alerta sonoro voltava toda vez que o app reiniciava ou
  // era usado em outro PC, mesmo já tendo sido lido.
  const [whatsappConversations, setWhatsappConversations] = useState<WhatsappStatusConversation[]>([])
  const [connectionState, setConnectionState] = useState<string | null>(null)
  const [openConversationId, setOpenConversationId] = useState<string | null>(null)

  function conversationNeedsAttention(conversation: WhatsappStatusConversation): boolean {
    if (!conversation.lastMessage || conversation.lastMessage.role !== 'customer') return false
    return !conversation.lastSeenAt || new Date(conversation.lastMessage.createdAt) > new Date(conversation.lastSeenAt)
  }

  const conversationsNeedingAttention = whatsappConversations.filter(conversationNeedsAttention)
  const whatsappDisconnected = connectionState !== null && connectionState !== 'open'
  const hasUrgentAlert = unacknowledgedOrders.length > 0 || conversationsNeedingAttention.length > 0 || whatsappDisconnected

  // Dois alertas sonoros independentes — pedido novo tem um timbre, mensagem
  // de cliente (ou WhatsApp desconectado) tem outro.
  const hasOrderAlert = unacknowledgedOrders.length > 0
  const hasMessageAlert = conversationsNeedingAttention.length > 0 || whatsappDisconnected

  useEffect(() => {
    if (!hasOrderAlert) {
      if (orderSoundIntervalRef.current !== null) {
        window.clearInterval(orderSoundIntervalRef.current)
        orderSoundIntervalRef.current = null
      }
      return
    }
    playOrderAlert()
    orderSoundIntervalRef.current = window.setInterval(() => { playOrderAlert() }, 12000)
    return () => {
      if (orderSoundIntervalRef.current !== null) {
        window.clearInterval(orderSoundIntervalRef.current)
        orderSoundIntervalRef.current = null
      }
    }
  }, [hasOrderAlert])

  useEffect(() => {
    if (!hasMessageAlert) {
      if (messageSoundIntervalRef.current !== null) {
        window.clearInterval(messageSoundIntervalRef.current)
        messageSoundIntervalRef.current = null
      }
      return
    }
    playMessageAlert()
    messageSoundIntervalRef.current = window.setInterval(() => { playMessageAlert() }, 12000)
    return () => {
      if (messageSoundIntervalRef.current !== null) {
        window.clearInterval(messageSoundIntervalRef.current)
        messageSoundIntervalRef.current = null
      }
    }
  }, [hasMessageAlert])

  const loadWhatsappStatus = useCallback(async () => {
    try {
      const data = await window.api.getWhatsappStatus()
      setWhatsappConversations(data.conversations ?? [])
      setConnectionState(data.connectionState ?? null)
    } catch {
      // Silencioso: não deve travar o resto do app se o WhatsApp estiver fora do ar.
    }
  }, [])

  useEffect(() => {
    if (!configured) return
    const initialLoad = window.setTimeout(() => { void loadWhatsappStatus() }, 800)
    const interval = window.setInterval(() => { void loadWhatsappStatus() }, 15000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [configured, loadWhatsappStatus])

  function markConversationSeen(conversationId: string) {
    const seenAt = new Date().toISOString()
    setWhatsappConversations(previous => previous.map(conversation =>
      conversation.id === conversationId ? { ...conversation, lastSeenAt: seenAt } : conversation
    ))
    void window.api.markWhatsappConversationSeen(conversationId)
  }

  function openWhatsappConversation(conversationId: string) {
    markConversationSeen(conversationId)
    setOpenConversationId(conversationId)
  }

  function closeWhatsappConversation() {
    if (openConversationId) markConversationSeen(openConversationId)
    setOpenConversationId(null)
  }

  async function updateStatus(id: string, status: OrderStatus) {
    // A conexão de origem viaja junto com o pedido. Sem ela, mudar o status de
    // um pedido da segunda loja iria para o servidor da primeira — que
    // responderia "não encontrado", ou acertaria outro pedido por acaso.
    const alvo = orders.find(o => o.id === id)
    const updated = await window.api.updateOrderStatus(id, status, alvo?.connectionId)
    if (updated) {
      setOrders(previous => previous.map(order => order.id === id ? { ...order, status } : order))
    } else {
      addNotification('Não foi possível atualizar o status do pedido')
    }
  }

  async function printOrder(order: Order) {
    const result = await window.api.printOrder(order)
    if (result === 'no-printer') addNotification('Configure a impressora nas configurações')
    if (result === 'error') addNotification('Não foi possível imprimir a comanda')
  }

  async function toggleAutoPrint() {
    const nextValue = !autoPrint
    await window.api.saveConfig({ autoPrint: nextValue ? 'true' : 'false' })
    setAutoPrint(nextValue)
    autoPrintRef.current = nextValue
    addNotification(nextValue ? 'Impressão automática ativada' : 'Impressão automática desativada')
  }

  async function handleSettingsSaved() {
    const ready = await readConfig()
    if (ready) {
      hasLoadedOrdersRef.current = false
      knownOrderIdsRef.current.clear()
      await loadOrders()
      setTab('kanban')
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[#0f0f0f] text-white select-none">
      <div
        className="flex items-center gap-3 px-4 py-2.5 bg-[#141414] border-b border-[#222] flex-shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="flex items-center gap-1.5 text-amber-400 font-bold text-sm">
          <CapivaraMark size={16} />
          {/* Com duas lojas, o nome de uma delas no cabeçalho seria mentira —
              a etiqueta de cada pedido é que diz de quem ele é. */}
          {stores.length === 1
            ? stores[0].storeName ?? 'Cardapia'
            : stores.length > 1
              ? `${stores.length} lojas`
              : 'Cardapia'}
        </span>

        {/* Loja fora do ar precisa aparecer: sem isso, a cozinha acha que
            simplesmente não chegou pedido daquela loja. */}
        {stores.filter((l) => !l.online).map((l) => (
          <span
            key={l.id}
            className="text-[11px] rounded-full border border-red-500/30 bg-red-500/10 text-red-300 px-2 py-0.5"
          >
            {l.storeName ?? 'Loja'} sem conexão
          </span>
        ))}
        <div className="flex-1" />

        {notifications.length > 0 && (
          <div className="bg-amber-500/15 border border-amber-500/30 rounded-xl px-3 py-1 text-xs text-amber-300 max-w-64 truncate">
            🔔 {notifications[0]}
          </div>
        )}

        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {configured && (
            <>
              <button onClick={() => void loadOrders()} title="Atualizar pedidos" className="p-1.5 rounded-lg hover:bg-[#222] text-gray-400 hover:text-white transition-colors">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => void toggleAutoPrint()}
                title={autoPrint ? 'Impressão automática ligada' : 'Impressão automática desligada'}
                className={`p-1.5 rounded-lg transition-colors ${autoPrint ? 'text-green-400 hover:bg-green-500/10' : 'text-gray-600 hover:bg-[#222]'}`}
              >
                <Printer size={14} />
              </button>
            </>
          )}
          <button onClick={() => setTab('kanban')} title="Pedidos" className={`relative p-1.5 rounded-lg transition-colors ${tab === 'kanban' ? 'text-amber-400' : 'text-gray-500 hover:text-white hover:bg-[#222]'}`}>
            <LayoutGrid size={14} />
            {unacknowledgedOrders.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                {unacknowledgedOrders.length}
              </span>
            )}
          </button>
          {configured && (
            <button onClick={() => setTab('whatsapp')} title="WhatsApp" className={`relative p-1.5 rounded-lg transition-colors ${tab === 'whatsapp' ? 'text-amber-400' : 'text-gray-500 hover:text-white hover:bg-[#222]'}`}>
              {whatsappDisconnected ? <WifiOff size={14} className="text-red-400" /> : <MessageCircle size={14} />}
              {conversationsNeedingAttention.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {conversationsNeedingAttention.length}
                </span>
              )}
            </button>
          )}
          {configured && (
            <button onClick={() => setTab('historico')} title="Histórico" className={`p-1.5 rounded-lg transition-colors ${tab === 'historico' ? 'text-amber-400' : 'text-gray-500 hover:text-white hover:bg-[#222]'}`}>
              <History size={14} />
            </button>
          )}
          <button onClick={() => setTab('settings')} title="Configurações" className={`p-1.5 rounded-lg transition-colors ${tab === 'settings' ? 'text-amber-400' : 'text-gray-500 hover:text-white hover:bg-[#222]'}`}>
            <SettingsIcon size={14} />
          </button>
        </div>
      </div>

      {hasUrgentAlert && tab !== 'whatsapp' && (
        <div className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 bg-red-500/10 border-b border-red-500/30 flex-shrink-0">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {unacknowledgedOrders.length > 0 && (
              <span className="flex items-center gap-1.5 text-amber-400 font-bold">
                🔔 {unacknowledgedOrders.length} pedido{unacknowledgedOrders.length > 1 ? 's' : ''} novo{unacknowledgedOrders.length > 1 ? 's' : ''} não visto{unacknowledgedOrders.length > 1 ? 's' : ''}
              </span>
            )}
            {whatsappDisconnected && (
              <span className="flex items-center gap-1.5 text-red-400 font-bold">
                <WifiOff size={12} /> WhatsApp desconectado{connectionState ? ` (${connectionState})` : ''}
              </span>
            )}
            {conversationsNeedingAttention.length > 0 && (
              <span className="flex items-center gap-1.5 text-amber-400 font-bold">
                <MessageCircle size={12} /> {conversationsNeedingAttention.length} cliente{conversationsNeedingAttention.length > 1 ? 's' : ''} esperando resposta no WhatsApp
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unacknowledgedOrders.length > 0 && tab !== 'kanban' && (
              <button onClick={() => setTab('kanban')} className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500 text-black font-bold">
                Ver pedidos
              </button>
            )}
            {conversationsNeedingAttention.length > 0 && (
              <button onClick={() => openWhatsappConversation(conversationsNeedingAttention[0].id)} className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500 text-black font-bold">
                Ver conversa
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {tab === 'settings' && <div className="h-full overflow-y-auto"><Settings onSaved={() => void handleSettingsSaved()} /></div>}

        {tab === 'whatsapp' && (
          <div className="h-full overflow-y-auto p-3">
            {whatsappDisconnected && (
              <div className="flex items-center gap-1.5 text-red-400 font-bold text-sm rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 mb-3">
                <WifiOff size={14} /> WhatsApp desconectado{connectionState ? ` (${connectionState})` : ''}
              </div>
            )}
            {whatsappConversations.length === 0 ? (
              <p className="text-center py-12 text-xs text-gray-600">Nenhuma conversa em atendimento manual no momento</p>
            ) : (
              <div className="space-y-2">
                {whatsappConversations.map(conversation => {
                  const needsAttention = conversationNeedsAttention(conversation)
                  return (
                    <button
                      key={conversation.id}
                      onClick={() => openWhatsappConversation(conversation.id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left rounded-xl bg-[#1a1a1a] border border-[#2a2a2a] hover:bg-[#222] transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {needsAttention && <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />}
                          <span className="text-sm font-medium text-white truncate">{conversation.phone}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                            conversation.status === 'awaiting_human'
                              ? 'text-amber-400 border-amber-400/30 bg-amber-400/5'
                              : 'text-green-400 border-green-400/30 bg-green-400/5'
                          }`}>
                            {conversation.status === 'awaiting_human' ? 'aguardando' : 'manual'}
                          </span>
                        </div>
                        {conversation.lastMessage?.content && (
                          <p className="text-xs text-gray-500 truncate">{conversation.lastMessage.content}</p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {openConversationId && (
          <WhatsappPanel
            conversationId={openConversationId}
            onClose={closeWhatsappConversation}
            onChanged={() => void loadWhatsappStatus()}
          />
        )}

        {tab === 'historico' && (
          <div className="h-full overflow-y-auto p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-gray-500">Pedidos com mais de 24h — saem do Kanban, mas ficam com o status em que pararam.</p>
              <select
                value={historyStatusFilter}
                onChange={e => setHistoryStatusFilter(e.target.value as OrderStatus | '')}
                className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500 flex-shrink-0"
              >
                <option value="">Todos</option>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </div>

            {historyLoading ? (
              <p className="text-center py-12 text-xs text-gray-600">Carregando...</p>
            ) : historyOrders.length === 0 ? (
              <p className="text-center py-12 text-xs text-gray-700">Nenhum pedido no histórico</p>
            ) : (
              <>
                <div className="space-y-2">
                  {historyOrders.map(order => (
                    <OrderCard key={order.id} order={order} onStatus={updateStatus} onPrint={printOrder} />
                  ))}
                </div>
                {historyHasMore && (
                  <button
                    onClick={() => void loadHistory(false)}
                    disabled={historyLoadingMore}
                    className="w-full text-xs py-2.5 rounded-xl border border-[#2a2a2a] text-gray-400 hover:border-amber-500 hover:text-amber-400 transition-colors disabled:opacity-50"
                  >
                    {historyLoadingMore ? 'Carregando...' : 'Carregar mais'}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'kanban' && !configured && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-3">
              <p className="text-4xl">⚙️</p>
              <p className="font-semibold text-lg">Configure o app primeiro</p>
              <p className="text-gray-500 text-sm">Informe a URL do cardápio e o token de integração nas configurações.</p>
              <button onClick={() => setTab('settings')} className="mt-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-xl text-sm">Ir para configurações</button>
            </div>
          </div>
        )}

        {tab === 'kanban' && configured && (
          <div className="h-full flex gap-0">
            {KANBAN_COLUMNS.map(column => {
              const columnOrders = orders.filter(order => column.statuses.includes(order.status))
              return (
                <div key={column.id} className="flex-1 flex flex-col min-w-0 border-r border-[#1a1a1a] last:border-0">
                  <div className="px-3 py-2.5 border-b-2 flex items-center justify-between flex-shrink-0" style={{ borderBottomColor: column.accent }}>
                    <span className="font-bold text-sm" style={{ color: column.accent }}>{column.label}</span>
                    {columnOrders.length > 0 && <span className="text-[11px] font-bold rounded-full w-5 h-5 flex items-center justify-center" style={{ background: `${column.accent}22`, color: column.accent }}>{columnOrders.length}</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {loading && columnOrders.length === 0 && <p className="text-center py-8 text-xs text-gray-600">Carregando...</p>}
                    {!loading && columnOrders.length === 0 && <p className="text-center py-8 text-xs text-gray-700">Vazio</p>}
                    {columnOrders.map(order => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        onStatus={updateStatus}
                        onPrint={printOrder}
                        onOpen={() => ackOrder(order.id)}
                        compact
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
