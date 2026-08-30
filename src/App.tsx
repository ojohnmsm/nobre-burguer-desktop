import { useCallback, useEffect, useRef, useState } from 'react'
import { History, LayoutGrid, Maximize2, MessageCircle, Minimize2, Minus, Power, Printer, RefreshCw, Settings as SettingsIcon, WifiOff, X } from 'lucide-react'
import { OrderCard } from './components/OrderCard'
import { Settings } from './components/Settings'
import { WhatsappPanel } from './components/WhatsappPanel'
import { CancelIfoodDialog } from './components/CancelIfoodDialog'
import { StorePausePanel } from './components/StorePausePanel'
import { DisputasPanel } from './components/DisputasPanel'
import { CapivaraMark } from './components/CapivaraMark'
import { KANBAN_COLUMNS, STATUS_LABELS, type Order, type OrderStatus } from './types'
import { rankStatus } from './orderFlow'
import type { WhatsappStatusConversation } from './electron-api'
import { loadNotificationSounds, playDriverArrivedAlert, playMessageAlert, playOrderAlert } from './notification-sound'

type Tab = 'kanban' | 'historico' | 'whatsapp' | 'settings'
const ALL_STATUSES: OrderStatus[] = [
  'pending', 'awaiting_payment', 'paid', 'preparing', 'ready_to_pickup', 'out_for_delivery', 'delivered', 'cancelled'
]
const HISTORY_PAGE_SIZE = 30

// O desktop repete a proteção da API: uma resposta antiga não pode colocar um
// Pix ou cartão online ainda pendente na tela, no som ou na impressão.
function isOperationalOrder(order: Order): boolean {
  return order.status !== 'awaiting_payment'
}

export default function App() {
  const [tab, setTab] = useState<Tab>('kanban')
  const [stores, setStores] = useState<{ id: string; storeName: string | null; online: boolean; ifoodConectado: boolean; ifoodPollingParadoSegundos: number | null }[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [autoPrint, setAutoPrint] = useState(true)
  const [notifications, setNotifications] = useState<string[]>([])
  const [configured, setConfigured] = useState(false)

  const notificationTimerRef = useRef<number | null>(null)
  const hasLoadedOrdersRef = useRef(false)
  const driverStageRef = useRef<Map<string, string>>(new Map())
  // Pedido do iFood: o card anda NA HORA ao clicar; este mapa segura a posição
  // otimista até o servidor alcançar (evento do iFood chegou) ou o prazo estourar.
  const optimisticRef = useRef<Map<string, { status: OrderStatus; ts: number }>>(new Map())
  const [windowMaximized, setWindowMaximized] = useState(false)

  // ── Pedidos novos não vistos (abrir o card reconhece) ──────────────────────
  // O "visto" é persistido no banco (orders.acknowledged_at) via API em vez
  // de ficar só em memória local — assim o alerta sincroniza entre todos os
  // dispositivos (esse app rodando em vários PCs + o admin web) e sobrevive
  // a reload/restart, já que a fonte de verdade não é mais o estado de uma
  // instância específica.
  const unacknowledgedOrders = orders.filter(order =>
    isOperationalOrder(order)
      && !order.acknowledged_at
      && order.status !== 'delivered'
      && order.status !== 'cancelled'
  )

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
      const operationalOrders = data.filter(isOperationalOrder)

      // Segura a posição otimista de pedido do iFood até o servidor alcançar
      // (evento chegou) ou o prazo de 90s estourar.
      const agoraMerge = Date.now()
      const idsAtuais = new Set(operationalOrders.map(o => o.id))
      for (const idOpt of [...optimisticRef.current.keys()]) {
        if (!idsAtuais.has(idOpt)) optimisticRef.current.delete(idOpt)
      }
      const comOtimista = operationalOrders.map(order => {
        const opt = optimisticRef.current.get(order.id)
        if (!opt) return order
        if (rankStatus(order.status) >= rankStatus(opt.status) || agoraMerge - opt.ts > 90_000) {
          optimisticRef.current.delete(order.id)
          return order
        }
        return { ...order, status: opt.status }
      })

      setOrders(comOtimista)
      hasLoadedOrdersRef.current = true

      // Pedido NOVO (alerta sonoro + toast + impressão) é responsabilidade do
      // PROCESSO PRINCIPAL agora (evento 'novo-pedido'), porque o timer do
      // renderer para quando a janela está minimizada / na bandeja. Aqui só
      // atualizamos o kanban na tela.

      // Som de "entregador chegou": na transição para o estágio na_loja, uma
      // vez por pedido. A primeira aparição não conta — só quando já vimos o
      // entregador antes noutro estágio.
      const novoStages = new Map<string, string>()
      let entregadorChegou = false
      for (const order of operationalOrders) {
        const estagio = order.ifood_driver?.estagio
        if (!estagio) continue
        const anterior = driverStageRef.current.get(order.id)
        if (estagio === 'na_loja' && anterior && anterior !== 'na_loja') entregadorChegou = true
        novoStages.set(order.id, estagio)
      }
      driverStageRef.current = novoStages
      if (entregadorChegou) {
        playDriverArrivedAlert()
        addNotification('🛵 Entregador do iFood chegou na loja')
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

    // Pedido novo detectado pelo PROCESSO PRINCIPAL — que roda mesmo com a
    // janela minimizada / na bandeja, quando os timers do renderer congelam.
    // Ele já imprimiu a comanda e disparou a notificação nativa do SO; aqui
    // só complementamos com o som configurável e o aviso dentro do app.
    const unsubscribeNovoPedido = window.api.onNewOrder(info => {
      playOrderAlert()
      const origem = info.canal === 'ifood' ? 'iFood — ' : info.canal === 'whatsapp' ? 'WhatsApp — ' : ''
      const retirada = info.isPickup ? 'RETIRADA — ' : ''
      addNotification(`🔔 ${retirada}${origem}Novo pedido #${info.label} — ${info.customerName}`)
      void loadOrders()
    })

    return () => {
      active = false
      unsubscribeError()
      unsubscribeNovoPedido()
      if (notificationTimerRef.current) window.clearTimeout(notificationTimerRef.current)
    }
  }, [addNotification, loadOrders, readConfig])

  useEffect(() => {
    if (!configured) return
    const interval = window.setInterval(() => { void loadOrders() }, 10000)
    return () => window.clearInterval(interval)
  }, [configured, loadOrders])

  // Reconsulta o estado das lojas (nome, online, saúde do polling do iFood)
  // periodicamente — é o que alimenta os chips de "sem conexão" na barra.
  useEffect(() => {
    if (!configured) return
    const interval = window.setInterval(() => {
      void window.api.getStores().then(setStores).catch(() => {})
    }, 60000)
    return () => window.clearInterval(interval)
  }, [configured])

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

  // Alerta sonoro toca UMA vez quando aparece, não em laço até reconhecer. O
  // som do pedido dispara em loadOrders() a cada pedido novo; o de mensagem,
  // aqui, na transição para "precisa de atenção".
  const hasMessageAlert = conversationsNeedingAttention.length > 0 || whatsappDisconnected

  useEffect(() => {
    if (hasMessageAlert) playMessageAlert()
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
    const isIfood = alvo?.channel === 'ifood'
    const anterior = alvo?.status

    // Resposta visual IMEDIATA para pedido do iFood: move o card já e verifica
    // com o iFood em segundo plano. Se recusar/falhar, volta.
    if (isIfood) {
      optimisticRef.current.set(id, { status, ts: Date.now() })
      setOrders(previous => previous.map(order => order.id === id ? { ...order, status } : order))
    }

    const res = await window.api.updateOrderStatus(id, status, alvo?.connectionId)

    if (!res.ok) {
      if (isIfood && anterior) {
        optimisticRef.current.delete(id)
        setOrders(previous => previous.map(order => order.id === id ? { ...order, status: anterior } : order))
      }
      addNotification(res.error || 'Não foi possível atualizar o status do pedido')
      return
    }
    if (res.requested) {
      // iFood aceitou processar. O card já está na posição nova; o evento real
      // confirma no próximo polling e o merge de loadOrders segura a posição
      // até lá (ou reverte no timeout de 90s).
      addNotification(res.message || 'Enviado ao iFood')
      return
    }
    optimisticRef.current.delete(id)
    setOrders(previous => previous.map(order => order.id === id ? { ...order, status } : order))
  }

  const [cancelandoIfood, setCancelandoIfood] = useState<Order | null>(null)
  const [pausePanelOpen, setPausePanelOpen] = useState(false)

  async function printOrder(order: Order) {
    const result = await window.api.printOrder(order)
    if (result === 'no-printer') addNotification('Configure a impressora nas configurações')
    if (result === 'error') addNotification('Não foi possível imprimir a comanda')
  }

  async function toggleAutoPrint() {
    const nextValue = !autoPrint
    await window.api.saveConfig({ autoPrint: nextValue ? 'true' : 'false' })
    setAutoPrint(nextValue)
    addNotification(nextValue ? 'Impressão automática ativada' : 'Impressão automática desativada')
  }

  async function handleSettingsSaved() {
    const ready = await readConfig()
    if (ready) {
      hasLoadedOrdersRef.current = false
      await loadOrders()
      setTab('kanban')
    }
  }

  useEffect(() => {
    let active = true
    void window.api.isWindowMaximized().then(maximized => {
      if (active) setWindowMaximized(maximized)
    })
    const unsubscribe = window.api.onWindowMaximizedChange(setWindowMaximized)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  function toggleMaximizeWindow() {
    void window.api.toggleMaximizeWindow().then(setWindowMaximized)
  }

  function handleTitleBarDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    // Os botões ficam dentro da barra para parecerem nativos, mas dois cliques
    // neles não podem propagar e maximizar a janela por acidente.
    if ((event.target as HTMLElement).closest('button')) return
    toggleMaximizeWindow()
  }

  return (
    <div className={`h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] select-none overflow-hidden ${windowMaximized ? '' : 'border border-[var(--border)] rounded-xl'}`}>
      <div
        className="flex min-h-12 items-center gap-3 pl-4 pr-0 bg-[var(--surface)] border-b border-[var(--border)] flex-shrink-0 shadow-[var(--shadow-sm)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        onDoubleClick={handleTitleBarDoubleClick}
      >
        <span className="flex items-center gap-2 text-[var(--primary)] font-bold text-sm">
          <CapivaraMark size={20} />
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
            className="text-[11px] rounded-full border border-red-500/30 bg-red-500/10 text-[var(--danger)] px-2 py-0.5"
          >
            {l.storeName ?? 'Loja'} sem conexão
          </span>
        ))}
        {/* Polling do iFood parado = a loja sai do ar no iFood em silêncio. */}
        {stores
          .filter((l) => l.online && l.ifoodConectado && l.ifoodPollingParadoSegundos != null && l.ifoodPollingParadoSegundos > 180)
          .map((l) => (
            <span
              key={`ifood-${l.id}`}
              className="text-[11px] rounded-full border border-red-500/30 bg-red-500/10 text-[var(--danger)] px-2 py-0.5"
            >
              {stores.length > 1 ? `${l.storeName ?? 'Loja'} — ` : ''}iFood sem conexão há {Math.round((l.ifoodPollingParadoSegundos ?? 0) / 60)}min
            </span>
          ))}
        <div className="flex-1" />

        {notifications.length > 0 && (
          <div className="bg-[var(--primary-tint)] border border-amber-500/30 rounded-xl px-3 py-1 text-xs text-[var(--primary-hover)] max-w-64 truncate">
            🔔 {notifications[0]}
          </div>
        )}

        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {configured && (
            <>
              <button onClick={() => void loadOrders()} title="Atualizar pedidos" className="p-1.5 rounded-lg hover:bg-[var(--border-light)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => void toggleAutoPrint()}
                title={autoPrint ? 'Impressão automática ligada' : 'Impressão automática desligada'}
                className={`p-1.5 rounded-lg transition-colors ${autoPrint ? 'text-[var(--success)] hover:bg-green-500/10' : 'text-[var(--text-xmuted)] hover:bg-[var(--border-light)]'}`}
              >
                <Printer size={14} />
              </button>
              <button
                onClick={() => setPausePanelOpen(v => !v)}
                title="Pausar loja (cardápio próprio / iFood)"
                className={`p-1.5 rounded-lg transition-colors ${pausePanelOpen ? 'text-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border-light)]'}`}
              >
                <Power size={14} />
              </button>
            </>
          )}
          <button onClick={() => setTab('kanban')} title="Pedidos" className={`relative p-1.5 rounded-lg transition-colors ${tab === 'kanban' ? 'text-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border-light)]'}`}>
            <LayoutGrid size={14} />
            {unacknowledgedOrders.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                {unacknowledgedOrders.length}
              </span>
            )}
          </button>
          {configured && (
            <button onClick={() => setTab('whatsapp')} title="WhatsApp" className={`relative p-1.5 rounded-lg transition-colors ${tab === 'whatsapp' ? 'text-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border-light)]'}`}>
              {whatsappDisconnected ? <WifiOff size={14} className="text-[var(--danger)]" /> : <MessageCircle size={14} />}
              {conversationsNeedingAttention.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {conversationsNeedingAttention.length}
                </span>
              )}
            </button>
          )}
          {configured && (
            <button onClick={() => setTab('historico')} title="Histórico" className={`p-1.5 rounded-lg transition-colors ${tab === 'historico' ? 'text-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border-light)]'}`}>
              <History size={14} />
            </button>
          )}
          <button onClick={() => setTab('settings')} title="Configurações" className={`p-1.5 rounded-lg transition-colors ${tab === 'settings' ? 'text-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border-light)]'}`}>
            <SettingsIcon size={14} />
          </button>
        </div>
        <div className="ml-1 flex h-12 self-stretch border-l border-[var(--border)]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => window.api.minimizeWindow()} title="Minimizar" aria-label="Minimizar" className="w-11 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--border-light)] hover:text-[var(--text)] transition-colors">
            <Minus size={16} />
          </button>
          <button onClick={toggleMaximizeWindow} title={windowMaximized ? 'Restaurar' : 'Maximizar'} aria-label={windowMaximized ? 'Restaurar' : 'Maximizar'} className="w-11 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--border-light)] hover:text-[var(--text)] transition-colors">
            {windowMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button onClick={() => window.api.closeWindow()} title="Fechar" aria-label="Fechar" className="w-11 flex items-center justify-center text-[var(--text-muted)] hover:bg-red-600 hover:text-white transition-colors">
            <X size={17} />
          </button>
        </div>
      </div>

      {tab !== 'whatsapp' && tab !== 'settings' && <DisputasPanel notify={addNotification} />}

      {hasUrgentAlert && tab !== 'whatsapp' && (
        <div className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 bg-red-500/10 border-b border-red-500/30 flex-shrink-0">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {unacknowledgedOrders.length > 0 && (
                <span className="flex items-center gap-1.5 text-[var(--primary)] font-bold">
                🔔 {unacknowledgedOrders.length} pedido{unacknowledgedOrders.length > 1 ? 's' : ''} novo{unacknowledgedOrders.length > 1 ? 's' : ''} não visto{unacknowledgedOrders.length > 1 ? 's' : ''}
              </span>
            )}
            {whatsappDisconnected && (
                <span className="flex items-center gap-1.5 text-[var(--danger)] font-bold">
                <WifiOff size={12} /> WhatsApp desconectado{connectionState ? ` (${connectionState})` : ''}
              </span>
            )}
            {conversationsNeedingAttention.length > 0 && (
                <span className="flex items-center gap-1.5 text-[var(--primary)] font-bold">
                <MessageCircle size={12} /> {conversationsNeedingAttention.length} cliente{conversationsNeedingAttention.length > 1 ? 's' : ''} esperando resposta no WhatsApp
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unacknowledgedOrders.length > 0 && tab !== 'kanban' && (
              <button onClick={() => setTab('kanban')} className="text-[11px] px-2.5 py-1 rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] font-bold">
                Ver pedidos
              </button>
            )}
            {conversationsNeedingAttention.length > 0 && (
              <button onClick={() => openWhatsappConversation(conversationsNeedingAttention[0].id)} className="text-[11px] px-2.5 py-1 rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] font-bold">
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
              <div className="flex items-center gap-1.5 text-[var(--danger)] font-bold text-sm rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 mb-3">
                <WifiOff size={14} /> WhatsApp desconectado{connectionState ? ` (${connectionState})` : ''}
              </div>
            )}
            {whatsappConversations.length === 0 ? (
              <p className="text-center py-12 text-xs text-[var(--text-xmuted)]">Nenhuma conversa em atendimento manual no momento</p>
            ) : (
              <div className="space-y-2">
                {whatsappConversations.map(conversation => {
                  const needsAttention = conversationNeedsAttention(conversation)
                  return (
                    <button
                      key={conversation.id}
                      onClick={() => openWhatsappConversation(conversation.id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left rounded-xl bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--border-light)] transition-colors shadow-[var(--shadow-sm)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {needsAttention && <span className="w-2 h-2 rounded-full bg-[var(--primary)] flex-shrink-0" />}
                          <span className="text-sm font-medium text-[var(--text)] truncate">{conversation.phone}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                            conversation.status === 'awaiting_human'
                              ? 'text-[var(--primary)] border-amber-500/30 bg-[var(--primary-tint)]'
                              : 'text-[var(--success)] border-green-500/30 bg-green-500/5'
                          }`}>
                            {conversation.status === 'awaiting_human' ? 'aguardando' : 'manual'}
                          </span>
                        </div>
                        {conversation.lastMessage?.content && (
                          <p className="text-xs text-[var(--text-muted)] truncate">{conversation.lastMessage.content}</p>
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
              <p className="text-xs text-[var(--text-muted)]">Pedidos com mais de 24h — saem do Kanban, mas ficam com o status em que pararam.</p>
              <select
                value={historyStatusFilter}
                onChange={e => setHistoryStatusFilter(e.target.value as OrderStatus | '')}
                className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--text)] focus:outline-none focus:border-[var(--primary)] flex-shrink-0"
              >
                <option value="">Todos</option>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </div>

            {historyLoading ? (
              <p className="text-center py-12 text-xs text-[var(--text-xmuted)]">Carregando...</p>
            ) : historyOrders.length === 0 ? (
              <p className="text-center py-12 text-xs text-[var(--text-muted)]">Nenhum pedido no histórico</p>
            ) : (
              <>
                <div className="space-y-2">
                  {historyOrders.map(order => (
                    <OrderCard key={order.id} order={order} onStatus={updateStatus} onPrint={printOrder} onCancelIfood={setCancelandoIfood} />
                  ))}
                </div>
                {historyHasMore && (
                  <button
                    onClick={() => void loadHistory(false)}
                    disabled={historyLoadingMore}
                    className="w-full text-xs py-2.5 rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-colors disabled:opacity-50"
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
              <p className="text-[var(--text-muted)] text-sm">Informe a URL do cardápio e o token de integração nas configurações.</p>
              <button onClick={() => setTab('settings')} className="mt-2 px-5 py-2.5 bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)] font-semibold rounded-xl text-sm">Ir para configurações</button>
            </div>
          </div>
        )}

        {tab === 'kanban' && configured && (
          <div className="h-full flex gap-0 overflow-x-auto">
            {KANBAN_COLUMNS.map(column => {
              const columnOrders = orders.filter(order => column.statuses.includes(order.status))
              return (
                <div key={column.id} className="flex-1 min-w-[168px] flex flex-col border-r border-[var(--border)] last:border-0">
                  <div className="px-3 py-2.5 border-b-2 flex items-center justify-between flex-shrink-0" style={{ borderBottomColor: column.accent }}>
                    <span className="font-bold text-sm" style={{ color: column.accent }}>{column.label}</span>
                    {columnOrders.length > 0 && <span className="text-[11px] font-bold rounded-full w-5 h-5 flex items-center justify-center" style={{ background: `${column.accent}22`, color: column.accent }}>{columnOrders.length}</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {loading && columnOrders.length === 0 && <p className="text-center py-8 text-xs text-[var(--text-xmuted)]">Carregando...</p>}
                    {!loading && columnOrders.length === 0 && <p className="text-center py-8 text-xs text-[var(--text-muted)]">Vazio</p>}
                    {columnOrders.map(order => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        onStatus={updateStatus}
                        onPrint={printOrder}
                        onCancelIfood={setCancelandoIfood}
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

      {pausePanelOpen && (
        <StorePausePanel
          stores={stores.map(s => ({ id: s.id, storeName: s.storeName }))}
          onClose={() => setPausePanelOpen(false)}
          notify={addNotification}
        />
      )}

      {cancelandoIfood && (
        <CancelIfoodDialog
          orderId={cancelandoIfood.id}
          connectionId={cancelandoIfood.connectionId}
          onClose={() => setCancelandoIfood(null)}
          onRequested={() => void loadOrders()}
          notify={addNotification}
        />
      )}
    </div>
  )
}
