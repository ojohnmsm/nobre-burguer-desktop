import { useState } from 'react'
import { ChevronDown, ChevronUp, Printer, Clock, Phone, MapPin, MessageSquare } from 'lucide-react'
import { Order, OrderStatus, STATUS_LABELS, PAYMENT_LABELS, fmtMoney, timeAgo , ehMarketplace} from '../types'
import { orderLabel } from '../orderLabel'
import { origemDoPedido, proximaEtapa } from '../orderFlow'
import { horaLocal, iconeVeiculo, nivelUrgencia, preparoInfo, textoEntregador } from '../orderTiming'

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

interface Props {
  order: Order
  onStatus: (id: string, status: OrderStatus) => void
  onPrint: (order: Order) => void
  onCancelIfood?: (order: Order) => void
  onOpen?: () => void
  compact?: boolean
}

export function OrderCard({ order, onStatus, onPrint, onCancelIfood, onOpen, compact = false }: Props) {
  const [open, setOpen] = useState(false)
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
  const fim = cozinhaConcluiu ? new Date(order.updated_at).getTime() : Date.now()
  const ago = timeAgo(order.created_at, fim)
  const isOld = !cozinhaConcluiu && (fim - new Date(order.created_at).getTime()) > 30 * 60000
  const preparo = preparoInfo(order, order.prep_target_minutes ?? 0)
  const urgencia = nivelUrgencia(order)
  const driver = order.ifood_driver ?? null
  const proxima = proximaEtapa(order)
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

  function handleCancel() {
    if (isIfood) { onCancelIfood?.(order); return }
    if (window.confirm('Cancelar este pedido?')) onStatus(order.id, 'cancelled')
  }

  return (
    <div className={`border rounded-xl overflow-hidden select-none shadow-[var(--shadow-sm)] ${urgenciaCard}`}>
      {/* Card header */}
      <button
        className="w-full p-3 flex items-start gap-2 text-left hover:bg-[var(--border-light)] transition-colors"
        onClick={() => setOpen(v => {
          const next = !v
          if (next) onOpen?.()
          return next
        })}
      >
        <div className="flex-1 min-w-0">
          {/* Linha 1: o NÚMERO, grande e sozinho — a âncora de toda conversa
              (cliente, entregador, app do iFood). A idade fica ao lado, na cor
              da urgência; o valor saiu daqui e vive no cartão expandido. */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono font-bold text-xl leading-tight tracking-tight text-[var(--text)] truncate">
              {orderLabel(order)}
            </span>
            <span className={`text-xs flex items-center gap-0.5 flex-shrink-0 tabular-nums ${urgenciaTexto}`}>
              <Clock size={11} />{cozinhaConcluiu ? `total ${ago}` : ago}
            </span>
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
            <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-bold tracking-wide border ${
              origem.tom === 'ifood' ? 'border-red-500/50 text-red-600'
              : origem.tom === 'whatsapp' ? 'border-green-500/50 text-green-700'
              : 'border-[var(--border)] text-[var(--text-muted)]'
            }`}>
              {origem.label.toUpperCase()}
            </span>
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
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {!compact && <>{order.order_items.length} {order.order_items.length === 1 ? 'item' : 'itens'}</>}
            {/* Pedido do iFood é sempre "pago no iFood" — a linha de pagamento
                só polui o card. */}
            {!doMarketplace && <>{!compact && ' · '}{PAYMENT_LABELS[order.payment_method] || order.payment_method}{order.card_on_delivery && ' (na entrega)'}</>}
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
          {order.notes && (
            <p className="text-xs text-[var(--primary)] mt-0.5 flex items-center gap-1 truncate">
              <MessageSquare size={10} className="flex-shrink-0" />
              {order.notes.slice(0, 45)}{order.notes.length > 45 ? '…' : ''}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end flex-shrink-0 pt-1">
          {open ? <ChevronUp size={12} className="text-[var(--text-xmuted)]" /> : <ChevronDown size={12} className="text-[var(--text-xmuted)]" />}
        </div>
      </button>

      {/* Expanded */}
      {open && (
        <div className="border-t border-[var(--border)] p-3 space-y-3 text-sm">
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
