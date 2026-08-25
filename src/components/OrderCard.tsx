import { useState } from 'react'
import { ChevronDown, ChevronUp, Printer, Clock, Phone, MapPin, MessageSquare } from 'lucide-react'
import { Order, OrderStatus, STATUS_LABELS, PAYMENT_LABELS, KANBAN_COLUMNS, fmtMoney, timeAgo } from '../types'

const ALL_STATUSES: OrderStatus[] = [
  'pending','awaiting_payment','paid','preparing','out_for_delivery','delivered','cancelled'
]

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending:          'text-[var(--text-muted)] border-[var(--border)]',
  awaiting_payment: 'text-[var(--primary)] border-amber-300',
  paid:             'text-[var(--success)] border-green-300',
  preparing:        'text-blue-700 border-blue-300',
  out_for_delivery: 'text-purple-700 border-purple-300',
  delivered:        'text-[var(--text-xmuted)] border-[var(--border)]',
  cancelled:        'text-[var(--danger)] border-red-300',
}

// Next logical status transitions (fast buttons)
const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  pending:          'preparing',
  awaiting_payment: 'preparing',
  paid:             'preparing',
  preparing:        'out_for_delivery',
  out_for_delivery: 'delivered',
}

interface Props {
  order: Order
  onStatus: (id: string, status: OrderStatus) => void
  onPrint: (order: Order) => void
  onOpen?: () => void
  compact?: boolean
}

export function OrderCard({ order, onStatus, onPrint, onOpen, compact = false }: Props) {
  const [open, setOpen] = useState(false)
  const ago = timeAgo(order.created_at)
  const isOld = (Date.now() - new Date(order.created_at).getTime()) > 30 * 60000
  const next = NEXT_STATUS[order.status]
  const isPickup = order.fulfillment_type === 'pickup'
  const pickupAddress = order.pickup_address?.trim()
  const viaWhatsapp = order.channel === 'whatsapp'

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden select-none shadow-[var(--shadow-sm)]">
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
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="font-mono font-bold text-xs text-[var(--text)]">
              #{order.id.slice(0, 8).toUpperCase()}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[order.status]}`}>
              {STATUS_LABELS[order.status]}
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
            {isPickup && (
              <span className="text-[10px] px-2 py-0.5 bg-amber-400 text-black font-black tracking-wide shadow-[0_0_0_1px_rgba(251,191,36,.45)]">
                RETIRADA
              </span>
            )}
            {viaWhatsapp && (
              <span className="text-[10px] px-2 py-0.5 bg-green-500 text-black font-black tracking-wide shadow-[0_0_0_1px_rgba(34,197,94,.45)]">
                WHATSAPP
              </span>
            )}
          </div>
            <p className="font-semibold text-sm text-[var(--text)] truncate">{order.customer_name}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {!compact && <>{order.order_items.length} {order.order_items.length === 1 ? 'item' : 'itens'} · </>}
            {PAYMENT_LABELS[order.payment_method] || order.payment_method}
          </p>
          {order.notes && (
            <p className="text-xs text-[var(--primary)] mt-0.5 flex items-center gap-1 truncate">
              <MessageSquare size={10} className="flex-shrink-0" />
              {order.notes.slice(0, 45)}{order.notes.length > 45 ? '…' : ''}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="text-[var(--primary)] font-bold text-sm">{fmtMoney(order.total_cents)}</span>
          <span className={`text-[10px] flex items-center gap-0.5 ${isOld ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
            <Clock size={9} />{ago}
          </span>
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
                  <span className="text-[var(--text)]">{item.quantity}× {item.product_name}</span>
                  <span className="text-[var(--text-muted)]">{fmtMoney(item.subtotal_cents)}</span>
                </div>
                {item.addon_selections?.map((a, i) => (
                  <p key={i} className="text-[11px] text-[var(--text-muted)] pl-3">
                    + {a.selectedOptions.map(o => o.name).join(', ')}
                  </p>
                ))}
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
          </div>

          {/* Notes */}
          {order.notes && (
            <p className="text-xs bg-[var(--primary-tint)] border border-amber-500/20 rounded-lg px-2 py-1.5 text-[var(--primary-hover)]">
              <span className="font-semibold">Obs:</span> {order.notes}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Quick next-step button */}
            {next && (
              <button
                onClick={() => onStatus(order.id, next)}
                className="flex-1 text-xs font-semibold py-2 px-3 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)] transition-colors"
              >
                → {STATUS_LABELS[next]}
              </button>
            )}
            {/* All status options */}
            <div className="flex flex-wrap gap-1">
              {ALL_STATUSES.filter(s => s !== order.status && s !== next).map(s => (
                <button key={s} onClick={() => onStatus(order.id, s)}
                  className="text-[10px] px-2 py-1 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors">
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <button
              onClick={() => onPrint(order)}
              className="flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors ml-auto"
            >
              <Printer size={11} /> Imprimir
            </button>
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
