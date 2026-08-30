import type { OrderStatus } from './types'

/**
 * O fluxo do pedido na cozinha, num lugar só — cópia de `lib/order-flow.ts` do
 * app web (o projeto já mantém utilitários puros duplicados entre os dois).
 *
 * Quando cada tela tinha a própria lista de "próximos status", elas divergiram:
 * um pedido "pronto" no app aparecia "em preparo" no web.
 */

export interface FlowOrder {
  status: OrderStatus
  channel?: string | null
  fulfillment_type?: 'delivery' | 'pickup' | null
}

/**
 * Status para os quais existe uma ação da LOJA no iFood (confirm, readyToPickup,
 * dispatch). `delivered`/`cancelled` num pedido do iFood chegam por evento, não
 * por botão — então o fluxo pra frente para em `out_for_delivery` no iFood.
 */
const IFOOD_ACIONAVEL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'preparing',
  'ready_to_pickup',
  'out_for_delivery',
])

export interface ProximaEtapa {
  status: OrderStatus
  label: string
}

export function proximaEtapa(order: FlowOrder): ProximaEtapa | null {
  const isIfood = order.channel === 'ifood'
  const isRetirada = order.fulfillment_type === 'pickup'

  let proxima: ProximaEtapa | null
  switch (order.status) {
    case 'pending':
    case 'awaiting_payment':
    case 'paid':
      proxima = { status: 'preparing', label: 'Confirmar pedido' }
      break
    case 'preparing':
      proxima = { status: 'ready_to_pickup', label: 'Marcar como pronto' }
      break
    case 'ready_to_pickup':
      proxima = isRetirada
        ? { status: 'delivered', label: 'Entregue ao cliente' }
        : { status: 'out_for_delivery', label: 'Saiu para entrega' }
      break
    case 'out_for_delivery':
      proxima = { status: 'delivered', label: 'Concluir pedido' }
      break
    default:
      proxima = null
  }

  if (!proxima) return null
  if (isIfood && !IFOOD_ACIONAVEL.has(proxima.status)) return null
  return proxima
}

/** Posição do status no fluxo (recebido = 0 … final = 4). Para barrar/comparar avanço. */
export function rankStatus(status: OrderStatus): number {
  switch (status) {
    case 'pending':
    case 'awaiting_payment':
    case 'paid':
      return 0
    case 'preparing':
      return 1
    case 'ready_to_pickup':
      return 2
    case 'out_for_delivery':
      return 3
    case 'delivered':
    case 'cancelled':
      return 4
  }
}

export type OrigemTom = 'ifood' | 'whatsapp' | 'web'

export interface Origem {
  label: string
  tom: OrigemTom
}

export function origemDoPedido(channel: string | null | undefined): Origem {
  if (channel === 'ifood') return { label: 'iFood', tom: 'ifood' }
  if (channel === 'whatsapp') return { label: 'WhatsApp', tom: 'whatsapp' }
  return { label: 'Site', tom: 'web' }
}
