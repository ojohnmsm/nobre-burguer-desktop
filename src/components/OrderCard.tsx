import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, Printer, Clock, Phone, MapPin, MessageSquare, Store } from 'lucide-react'
import { Order, OrderStatus, STATUS_LABELS, PAYMENT_LABELS, fmtMoney, timeAgo , ehMarketplace} from '../types'
import { orderLabel } from '../orderLabel'
import { origemDoPedido, proximaEtapa } from '../orderFlow'
import { horaLocal, iconeVeiculo, nivelUrgencia, preparoInfo, textoEntregador, textoEntregadorCurto, textoEntrega99Food, textoEntrega99FoodCurto } from '../orderTiming'
import canalIfood from '../assets/canais/canal-ifood.png'
import canal99Food from '../assets/canais/canal-99food.png'
import canalSite from '../assets/canais/canal-site.png'
import canalWhatsapp from '../assets/canais/canal-whatsapp.png'

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending:          'text-[var(--text-muted)] border-[var(--border)]',
  awaiting_payment: 'text-[var(--primary)] border-amber-300',
  paid:             'text-[var(--success)] border-green-300',
  preparing:        'text-blue-700 border-blue-300',
  ready_to_pickup:  'text-teal-700 border-teal-300',
  out_for_delivery: 'text-purple-700 border-purple-300',
  delivered:        'text-[var(--text-xmuted)] border-[var(--border)]',
  cancelled:        'text-[var(--danger)] border-red-300',
}

/**
 * Código de 4 dígitos que a 99Food usa para confirmar a entrega: ao
 * entregador da própria 99Food (`handover_code`, delivery_type=1) ou ao
 * cliente na retirada (`takeaway_code`, delivery_type=0). Não é o
 * `pickup_code` legado — a doc oficial marca esse como "não será exibido ao
 * entregador". Cópia do helper equivalente em app/admin/pedidos/page.tsx.
 */
function codigoEntrega99Food(order: Order): { tipo: 'entrega' | 'retirada'; codigo: string } | null {
  if (order.channel !== '99food' || !order.external_payload) return null
  const p = order.external_payload as { delivery_type?: unknown; handover_code?: unknown; takeaway_code?: unknown }
  if ((p.delivery_type === 1 || p.delivery_type === '1') && typeof p.handover_code === 'string' && p.handover_code.trim()) {
    return { tipo: 'entrega', codigo: p.handover_code.trim() }
  }
  if ((p.delivery_type === 0 || p.delivery_type === '0') && typeof p.takeaway_code === 'string' && p.takeaway_code.trim()) {
    return { tipo: 'retirada', codigo: p.takeaway_code.trim() }
  }
  return null
}

interface Props {
  order: Order
  onStatus: (id: string, status: OrderStatus) => void
  onPrint: (order: Order) => void
  onCancelIfood?: (order: Order) => void
  onOpen?: (id: string) => void
  /**
   * "Agora", em blocos de 15s — não `Date.now()` cru. O card precisa
   * redesenhar quando o tempo passa (a cor de urgência e o "há Xmin" têm que
   * avançar mesmo sem nenhum dado mudar), mas só isto: se cada render lesse
   * `Date.now()` direto, o React.memo abaixo nunca bateria uma comparação
   * igual, porque o valor seria sempre diferente — o memo não serviria pra
   * nada. Vindo como prop (calculado uma vez por leva de pedidos, no
   * App.tsx), os cartões que não mudaram em nada pulam o redesenho entre uma
   * leva e outra dentro do mesmo bloco de 15s.
   */
  agoraBucket: number
  compact?: boolean
}

function OrderCardImpl({ order, onStatus, onPrint, onCancelIfood, onOpen, agoraBucket, compact = false }: Props) {
  const [open, setOpen] = useState(false)
  const agora = agoraBucket * 15000
  const isIfood = order.channel === 'ifood'
  // Vale para qualquer marketplace; `isIfood` fica só para o que é do iFood.
  const doMarketplace = ehMarketplace(order.channel)
  const isTerminal = order.status === 'delivered' || order.status === 'cancelled'
  // A COZINHA já terminou com este pedido? Terminal, ou pedido do iFood que
  // saiu do preparo — daí em diante o motoboy é problema do iFood, não da
  // cozinha. A contagem CONGELA no instante em que saiu do preparo
  // (updated_at), em vez de correr para sempre.
  const cozinhaConcluiu = isTerminal
    || (doMarketplace && (order.status === 'ready_to_pickup' || order.status === 'out_for_delivery'))
  const fim = cozinhaConcluiu ? new Date(order.updated_at).getTime() : agora
  const ago = timeAgo(order.created_at, fim)
  const isOld = !cozinhaConcluiu && (fim - new Date(order.created_at).getTime()) > 30 * 60000
  const preparo = preparoInfo(order, order.prep_target_minutes ?? 0, agora)
  const urgencia = nivelUrgencia(order, agora)
  const driver = order.ifood_driver ?? null
  const proxima = proximaEtapa(order)
  // Pendente de aceite — web/whatsapp sempre, e marketplace só até o aceite
  // automático ecoar de volta (99Food agora é otimista, ver
  // lib/opendelivery/transport.ts; iFood pode levar um ciclo de polling).
  // Sem coluna própria pra isso: o destaque é o que avisa, dentro de "Em preparo".
  const precisaAceite = order.status === 'pending' || order.status === 'paid' || order.status === 'awaiting_payment'
  const isPickup = order.fulfillment_type === 'pickup'
  const pickupAddress = order.pickup_address?.trim()
  const origem = origemDoPedido(order.channel)

  // A cor do cartão inteiro segue o TEMPO, não o canal: faixa lateral sempre
  // (verde → amarelo → vermelho) e um leve fundo vermelho quando já atrasou.
  const urgenciaCard =
    urgencia === 'atrasada'   ? 'border-red-400 border-l-4 border-l-red-500 bg-red-500/10'
    : urgencia === 'aquecendo' ? 'border-[var(--border)] border-l-4 border-l-amber-500 bg-[var(--card)]'
    : urgencia === 'fresca'    ? 'border-[var(--border)] border-l-4 border-l-green-500 bg-[var(--card)]'
    : 'border-[var(--border)] bg-[var(--card)]'
  const urgenciaTexto =
    urgencia === 'atrasada'   ? 'text-[var(--danger)] font-bold'
    : urgencia === 'aquecendo' ? 'text-amber-600'
    : urgencia === 'fresca'    ? 'text-green-600'
    : isOld ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'

  // Chip de tempo do cabeçalho compacto: MESMA cor da urgência do cartão (só
  // reembalada em pílula) — mas o número prioriza "quanto falta pra preparar"
  // sobre a idade, porque é isso que decide o próximo passo da cozinha.
  const tempoDisponivel = !isTerminal && !cozinhaConcluiu && preparo.alvoISO != null
  const chipTempoTexto = tempoDisponivel
    ? (preparo.atrasado ? `atrasado ${Math.abs(preparo.restanteMin ?? 0)}min` : `${preparo.restanteMin}min`)
    : (cozinhaConcluiu ? `total ${ago}` : ago)
  const chipTempoClasse =
    urgencia === 'atrasada'    ? 'bg-red-500/15 border border-red-400 text-[var(--danger)]'
    : urgencia === 'aquecendo' ? 'bg-amber-500/15 border border-amber-400 text-amber-600'
    : urgencia === 'fresca'    ? 'bg-green-500/10 border border-green-400 text-green-600'
    : 'text-[var(--text-muted)]'
  // 99Food: "quem entrega" + estágio/ETA ao vivo, sem rastreio de estágio pro
  // iFood (esse já vem de `driver`) — mesmo slot visual.
  const entrega99Food = textoEntrega99Food(order, agora)
  const entrega99FoodCurto = textoEntrega99FoodCurto(order, agora)
  const codigo99Food = codigoEntrega99Food(order)
  // Selo enxuto pro card FECHADO (regra dos três segundos: ícone + até ~7
  // caracteres, sem nome) — cópia do mesmo ajuste em app/admin/pedidos no
  // projeto web. A frase completa (com nome) continua só no card expandido,
  // mais abaixo — não muda.
  const textoChipEntregador = driver ? textoEntregadorCurto(driver) : entrega99FoodCurto
  const destaqueChipEntregador = driver
    ? (driver.estagio === 'na_loja' || (driver.pickupEtaMin != null && driver.pickupEtaMin <= 5))
    : (entrega99FoodCurto === 'na loja' || entrega99FoodCurto === 'chegou')

  function handleCancel() {
    // Todo marketplace (iFood, 99Food) cancela com motivo, pela mesma tela —
    // não é escolha nossa, é o que o servidor aceita (ver applyOrderStatusChange).
    if (doMarketplace) { onCancelIfood?.(order); return }
    if (window.confirm('Cancelar este pedido?')) onStatus(order.id, 'cancelled')
  }

  return (
    <div className={`border ${compact ? 'rounded-lg' : 'rounded-xl'} overflow-hidden select-none shadow-[var(--shadow-sm)] ${urgenciaCard} ${
      // Cartão aberto (clicado) ganha um contorno de outra cor — só assim dá
      // pra achar de relance qual pedido está com o detalhe na tela.
      open ? 'ring-2 ring-[var(--primary)]' : ''
    }`}>
      {/* Card header */}
      <button
        className={`w-full ${compact ? 'p-2.5' : 'p-3'} flex items-start gap-2 text-left hover:bg-[var(--border-light)] transition-colors`}
        onClick={() => setOpen(v => {
          const next = !v
          if (next) onOpen?.(order.id)
          return next
        })}
      >
        <div className="flex-1 min-w-0">
          {/* Linha 1: o NÚMERO, grande e sozinho — a âncora de toda conversa
              (cliente, entregador, app do iFood). A idade fica ao lado, na cor
              da urgência; o valor saiu daqui e vive no cartão expandido. */}
          <div className="flex items-baseline justify-between gap-2">
            <span className={`font-mono font-bold leading-tight tracking-tight text-[var(--text)] truncate ${compact ? 'text-base' : 'text-xl'}`}>
              {orderLabel(order)}
            </span>
            {compact ? (
              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md flex items-center gap-1 flex-shrink-0 tabular-nums ${chipTempoClasse}`}>
                <Clock size={11} />{chipTempoTexto}
              </span>
            ) : (
              <span className={`text-xs flex items-center gap-0.5 flex-shrink-0 tabular-nums ${urgenciaTexto}`}>
                <Clock size={11} />{cozinhaConcluiu ? `total ${ago}` : ago}
              </span>
            )}
          </div>
          {/* Linha 2: modalidade (fixa e forte — muda o que a cozinha faz),
              canal em tom discreto, etiqueta da loja quando há mais de uma, e o
              status só na visão lista (no kanban a coluna já diz a etapa). */}
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <span className={`text-[10px] px-2 py-0.5 rounded-sm font-black tracking-wide ${
              isPickup
                ? 'bg-amber-400 text-black shadow-[0_0_0_1px_rgba(251,191,36,.45)]'
                : 'border border-[var(--text-muted)] text-[var(--text-muted)]'
            }`}>
              {isPickup ? 'RETIRADA' : 'ENTREGA'}
            </span>
            {precisaAceite && (
              <span className="text-[10px] px-2 py-0.5 rounded-sm font-black tracking-wide bg-amber-500 text-black animate-pulse">
                ACEITAR
              </span>
            )}
            {compact ? <CanalCompacto canal={order.channel} /> : (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-bold tracking-wide border ${
                origem.tom === 'ifood' ? 'border-red-500/50 text-red-600'
                : origem.tom === '99food' ? 'border-amber-500/50 text-amber-700'
                : origem.tom === 'whatsapp' ? 'border-green-500/50 text-green-700'
                : 'border-[var(--border)] text-[var(--text-muted)]'
              }`}>
                {origem.label.toUpperCase()}
              </span>
            )}
            {/* Só no card fechado (compact): a versão com nome/frase inteira
                já aparece embaixo, no não-compact e no recap expandido. */}
            {compact && textoChipEntregador && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-bold flex items-center gap-1 flex-shrink-0 ${
                destaqueChipEntregador
                  ? 'bg-amber-500/15 text-[var(--primary)]'
                  : 'border border-[var(--border)] text-[var(--text-muted)]'
              }`}>
                {driver ? iconeVeiculo(driver.veiculo) : '🛵'}
                {textoChipEntregador}
              </span>
            )}
            {/* A etiqueta da loja só aparece quando o computador atende mais de
                uma — com uma só, ela repetiria em todo cartão sem informar
                nada. A cor vem do nome, então cada loja recebe sempre a mesma
                e a cozinha aprende a reconhecer sem ler. */}
            {order.storeLabel && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                style={corDaLoja(order.storeLabel)}
              >
                {order.storeLabel}
              </span>
            )}
            {!compact && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[order.status]}`}>
                {STATUS_LABELS[order.status]}
              </span>
            )}
          </div>
          <p className="font-semibold text-sm text-[var(--text)] truncate mt-1">{order.customer_name}</p>
          {!compact && (
            <>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {order.order_items.length} {order.order_items.length === 1 ? 'item' : 'itens'}
                {/* Pedido de marketplace é sempre "pago no app" — a linha de
                    pagamento só polui o card. */}
                {!doMarketplace && <> · {PAYMENT_LABELS[order.payment_method] || order.payment_method}{order.card_on_delivery && ' (na entrega)'}</>}
              </p>
              {!isTerminal && preparo.alvoISO && (
                <p className={`text-xs mt-0.5 flex items-center gap-1 ${
                  preparo.atrasado ? 'text-[var(--danger)] font-bold'
                  : (preparo.restanteMin ?? 99) <= 10 ? 'text-[var(--primary)]'
                  : 'text-[var(--text-muted)]'
                }`}>
                  <Clock size={10} className="flex-shrink-0" />
                  Preparar até {horaLocal(preparo.alvoISO)} · {preparo.atrasado
                    ? `atrasado ${Math.abs(preparo.restanteMin ?? 0)}min`
                    : `faltam ${preparo.restanteMin}min`}
                </p>
              )}
              {driver && (
                <p className={`text-xs mt-0.5 flex items-center gap-1 ${
                  driver.estagio === 'na_loja' || (driver.pickupEtaMin != null && driver.pickupEtaMin <= 5)
                    ? 'text-[var(--primary)] font-bold' : 'text-[var(--text-muted)]'
                }`}>
                  <span>{iconeVeiculo(driver.veiculo)}</span>
                  <span className="truncate">{textoEntregador(driver)}</span>
                </p>
              )}
              {entrega99Food && (
                <p className="text-xs mt-0.5 flex items-center gap-1 text-[var(--text-muted)] truncate">
                  <span>🛵</span>
                  <span className="truncate">{entrega99Food}</span>
                </p>
              )}
              {order.notes && (
                <p className="text-xs text-[var(--primary)] mt-0.5 flex items-center gap-1 truncate">
                  <MessageSquare size={10} className="flex-shrink-0" />
                  {order.notes.slice(0, 45)}{order.notes.length > 45 ? '…' : ''}
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex flex-col items-end flex-shrink-0 pt-1">
          {open ? <ChevronUp size={12} className="text-[var(--text-xmuted)]" /> : <ChevronDown size={12} className="text-[var(--text-xmuted)]" />}
        </div>
      </button>

      {compact && !open && !isTerminal && proxima && (
        <div className="flex gap-1 px-2.5 pb-2.5">
          <button
            onClick={() => onStatus(order.id, proxima.status)}
            className="min-w-0 flex-1 truncate rounded-md bg-[var(--primary)] px-2 py-1.5 text-xs font-bold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            {proxima.label}
          </button>
          <button
            onClick={() => { setOpen(true); onOpen?.(order.id) }}
            aria-label="Ver detalhes do pedido"
            className="rounded-md border border-[var(--border)] px-2 text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      )}

      {/* Expanded */}
      {open && (
        <div className="border-t border-[var(--border)] p-3 space-y-3 text-sm">
          {/* Recap do compacto: pagamento, preparo detalhado e entregador não
              aparecem no card fechado em modo compacto — não sumiram, só
              ficaram a um clique. */}
          {compact && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 border-b border-[var(--border)] text-xs">
              {!doMarketplace && (
                <span className="text-[var(--text-muted)]">{PAYMENT_LABELS[order.payment_method] || order.payment_method}{order.card_on_delivery && ' (na entrega)'}</span>
              )}
              {!isTerminal && preparo.alvoISO && (
                <span className={`flex items-center gap-1 ${
                  preparo.atrasado ? 'text-[var(--danger)] font-bold'
                  : (preparo.restanteMin ?? 99) <= 10 ? 'text-[var(--primary)]'
                  : 'text-[var(--text-muted)]'
                }`}>
                  <Clock size={10} className="flex-shrink-0" />
                  Preparar até {horaLocal(preparo.alvoISO)} · {preparo.atrasado
                    ? `atrasado ${Math.abs(preparo.restanteMin ?? 0)}min`
                    : `faltam ${preparo.restanteMin}min`}
                </span>
              )}
              {driver && (
                <span className={`flex items-center gap-1 ${
                  driver.estagio === 'na_loja' || (driver.pickupEtaMin != null && driver.pickupEtaMin <= 5)
                    ? 'text-[var(--primary)] font-bold' : 'text-[var(--text-muted)]'
                }`}>
                  <span>{iconeVeiculo(driver.veiculo)}</span>
                  <span>{textoEntregador(driver)}</span>
                </span>
              )}
              {entrega99Food && (
                <span className="flex items-center gap-1 text-[var(--text-muted)]">
                  <span>🛵</span>
                  <span>{entrega99Food}</span>
                </span>
              )}
            </div>
          )}
          {/* Items */}
          <div className="space-y-1">
            {order.order_items.map(item => (
              <div key={item.id}>
                <div className="flex justify-between">
                  <span className="text-[var(--text)]">{item.quantity}× {item.product_name}{item.variation_name ? ` · ${item.variation_name}` : ''}</span>
                  <span className="text-[var(--text-muted)]">{fmtMoney(item.subtotal_cents)}</span>
                </div>
                {item.addon_selections?.map((a, i) => (
                  <p key={i} className="text-[11px] text-[var(--text-muted)] pl-3">
                    + {a.selectedOptions.map(o => o.name).join(', ')}
                  </p>
                ))}
                {item.notes && (
                  <p className="text-[11px] text-[var(--primary)] pl-3">obs: {item.notes}</p>
                )}
              </div>
            ))}
            <div className="flex justify-between font-bold pt-1 border-t border-[var(--border)]">
              <span>Total</span>
              <span className="text-[var(--primary)]">{fmtMoney(order.total_cents)}</span>
            </div>
          </div>

          {/* Address */}
          <div className="text-xs text-[var(--text-muted)] space-y-0.5">
            {isPickup ? (
              <p className="flex items-start gap-1 text-[var(--primary-hover)]">
                <MapPin size={10} className="mt-0.5 flex-shrink-0" />
                <span><span className="font-bold">Retirar em:</span> {pickupAddress || 'Endereço a confirmar com a loja'}</span>
              </p>
            ) : (
              <p className="flex items-center gap-1">
                <MapPin size={10} className="flex-shrink-0" />
                {order.address}, {order.address_number}
                {order.address_complement ? `, ${order.address_complement}` : ''}
                {order.neighborhood ? ` — ${order.neighborhood}` : ''}
              </p>
            )}
            <p className="flex items-center gap-1"><Phone size={10} /> {order.customer_phone}</p>
            {isIfood && order.ifood_pickup_code && (
              <p className="text-[var(--text)]">
                <span className="font-bold">Código de coleta:</span>{' '}
                <span className="font-mono text-[var(--primary)]">{order.ifood_pickup_code}</span>
              </p>
            )}
            {codigo99Food && (
              <p className="text-[var(--text)]">
                <span className="font-bold">{codigo99Food.tipo === 'retirada' ? 'Código de retirada:' : 'Código de entrega:'}</span>{' '}
                <span className="font-mono text-[var(--primary)]">{codigo99Food.codigo}</span>
              </p>
            )}
          </div>

          {/* Notes */}
          {order.notes && (
            <p className="text-xs bg-[var(--primary-tint)] border border-amber-500/20 rounded-lg px-2 py-1.5 text-[var(--primary-hover)]">
              <span className="font-semibold">Obs:</span> {order.notes}
            </p>
          )}

          {/* Ações — fluxo só pra frente: um botão grande avança a etapa. */}
          <div className="space-y-2">
            {proxima && (
              <button
                onClick={() => onStatus(order.id, proxima.status)}
                className="w-full text-sm font-bold py-2.5 px-3 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)] transition-colors"
              >
                {proxima.label}
              </button>
            )}
            {isIfood && order.status === 'out_for_delivery' && (
              <p className="text-[10px] text-[var(--text-muted)] text-center">O iFood conclui quando o entregador finalizar.</p>
            )}
            <div className="flex items-center gap-2">
              {!isTerminal && (
                <button
                  onClick={handleCancel}
                  className="text-[11px] px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:border-red-500 hover:text-[var(--danger)] transition-colors"
                >
                  Cancelar
                </button>
              )}
              <button
                onClick={() => onPrint(order)}
                className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors ml-auto"
              >
                <Printer size={11} /> Imprimir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Comparação padrão (rasa, todas as props) — funciona porque `order` chega
// com referência ESTÁVEL do App.tsx quando o conteúdo não muda entre levas
// (ver a estabilização em aplicarPedidosRecebidos); sem aquilo, o clone
// estruturado do IPC criaria um objeto novo a cada leva e este memo nunca
// bateria nada.
export const OrderCard = memo(OrderCardImpl)

// Parcial de propósito: "balcao" não tem logo (pedido criado por quem já está
// na tela, não veio de canal nenhum) — CanalCompacto cai no ícone genérico.
const CANAIS: Partial<Record<Order['channel'], { src: string; alt: string; largura: number }>> = {
  ifood: { src: canalIfood, alt: 'iFood', largura: 28 },
  '99food': { src: canal99Food, alt: '99Food', largura: 34 },
  whatsapp: { src: canalWhatsapp, alt: 'WhatsApp', largura: 15 },
  web: { src: canalSite, alt: 'Cardápio', largura: 15 },
}

function CanalCompacto({ canal }: { canal: Order['channel'] }) {
  const item = CANAIS[canal]
  if (!item) {
    return <span className="flex h-5 items-center rounded-sm border border-[var(--border)] bg-white px-1.5" title="Balcão">
      <Store size={12} className="text-[var(--text-muted)]" />
    </span>
  }
  return <span className="flex h-5 items-center rounded-sm border border-[var(--border)] bg-white px-1.5" title={item.alt}>
    <img src={item.src} alt={item.alt} width={item.largura} className="max-h-3.5 object-contain" />
  </span>
}

/**
 * Cor estável a partir do nome da loja.
 *
 * Derivada do texto e não sorteada: a mesma loja precisa ter a mesma cor toda
 * vez que o aplicativo abre, senão a etiqueta vira decoração em vez de pista.
 */
function corDaLoja(nome: string): React.CSSProperties {
  let soma = 0
  for (const ch of nome) soma = (soma * 31 + ch.charCodeAt(0)) % 360
  return {
    backgroundColor: `hsl(${soma} 72% 94%)`,
    color: `hsl(${soma} 52% 28%)`,
    boxShadow: `0 0 0 1px hsl(${soma} 48% 72%)`,
  }
}
