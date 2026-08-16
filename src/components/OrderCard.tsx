import { useState } from 'react'
import { ChevronDown, ChevronUp, Printer, Clock, Phone, MapPin, MessageSquare } from 'lucide-react'
import { Order, OrderStatus, STATUS_LABELS, PAYMENT_LABELS, KANBAN_COLUMNS, fmtMoney, timeAgo } from '../types'

const ALL_STATUSES: OrderStatus[] = [
  'pending','awaiting_payment','paid','preparing','out_for_delivery','delivered','cancelled'
]

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending:          'text-gray-400 border-gray-600',
  awaiting_payment: 'text-amber-400 border-amber-700',
  paid:             'text-green-400 border-green-700',
  preparing:        'text-blue-400 border-blue-700',
  out_for_delivery: 'text-purple-400 border-purple-700',
  delivered:        'text-gray-500 border-gray-700',
  cancelled:        'text-red-400 border-red-700',
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
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl overflow-hidden select-none">
      {/* Card header */}
      <button
        className="w-full p-3 flex items-start gap-2 text-left hover:bg-[#222] transition-colors"
        onClick={() => setOpen(v => {
          const next = !v
          if (next) onOpen?.()
          return next
        })}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="font-mono font-bold text-xs text-white">
              #{order.id.slice(0, 8).toUpperCase()}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[order.status]}`}>
              {STATUS_LABELS[order.status]}
            </span>
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
          <p className="font-semibold text-sm text-white truncate">{order.customer_name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {!compact && <>{order.order_items.length} {order.order_items.length === 1 ? 'item' : 'itens'} · </>}
            {PAYMENT_LABELS[order.payment_method] || order.payment_method}
          </p>
          {order.notes && (
            <p className="text-xs text-amber-400 mt-0.5 flex items-center gap-1 truncate">
              <MessageSquare size={10} className="flex-shrink-0" />
              {order.notes.slice(0, 45)}{order.notes.length > 45 ? '…' : ''}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="text-amber-400 font-bold text-sm">{fmtMoney(order.total_cents)}</span>
          <span className={`text-[10px] flex items-center gap-0.5 ${isOld ? 'text-red-400' : 'text-gray-500'}`}>
            <Clock size={9} />{ago}
          </span>
          {open ? <ChevronUp size={12} className="text-gray-600" /> : <ChevronDown size={12} className="text-gray-600" />}
        </div>
      </button>

      {/* Expanded */}
      {open && (
        <div className="border-t border-[#2a2a2a] p-3 space-y-3 text-sm">
          {/* Items */}
          <div className="space-y-1">
            {order.order_items.map(item => (
              <div key={item.id}>
                <div className="flex justify-between">
                  <span className="text-gray-200">{item.quantity}× {item.product_name}</span>
                  <span className="text-gray-500">{fmtMoney(item.subtotal_cents)}</span>
                </div>
                {item.addon_selections?.map((a, i) => (
                  <p key={i} className="text-[11px] text-gray-500 pl-3">
                    + {a.selectedOptions.map(o => o.name).join(', ')}
                  </p>
                ))}
              </div>
            ))}
            <div className="flex justify-between font-bold pt-1 border-t border-[#2a2a2a]">
              <span>Total</span>
              <span className="text-amber-400">{fmtMoney(order.total_cents)}</span>
            </div>
          </div>

          {/* Address */}
          <div className="text-xs text-gray-500 space-y-0.5">
            {isPickup ? (
              <p className="flex items-start gap-1 text-amber-300">
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
            <p className="text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5 text-amber-300">
              <span className="font-semibold">Obs:</span> {order.notes}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Quick next-step button */}
            {next && (
              <button
                onClick={() => onStatus(order.id, next)}
                className="flex-1 text-xs font-semibold py-2 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-colors"
              >
                → {STATUS_LABELS[next]}
              </button>
            )}
            {/* All status options */}
            <div className="flex flex-wrap gap-1">
              {ALL_STATUSES.filter(s => s !== order.status && s !== next).map(s => (
                <button key={s} onClick={() => onStatus(order.id, s)}
                  className="text-[10px] px-2 py-1 rounded-lg border border-[#333] hover:border-amber-500 hover:text-amber-400 text-gray-400 transition-colors">
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <button
              onClick={() => onPrint(order)}
              className="flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg border border-[#333] hover:border-amber-500 hover:text-amber-400 text-gray-400 transition-colors ml-auto"
            >
              <Printer size={11} /> Imprimir
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
