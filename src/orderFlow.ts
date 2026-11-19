import type { OrderStatus } from './types'

/**
 * O fluxo do pedido na cozinha, num lugar só — cópia de `lib/order-flow.ts` do
 * app web (a fonte da verdade), sincronizada em 19/11/2026. Ao mudar o fluxo
 * lá, copie aqui: o projeto mantém utilitários puros duplicados entre os dois.
 *
 * Quando cada tela tinha a própria lista de "próximos status", elas divergiram:
 * um pedido "pronto" no app aparecia "em preparo" no web.
 */

export interface FlowOrder {
  status: OrderStatus
  channel?: string | null
  fulfillment_type?: 'delivery' | 'pickup' | null
  /** `delivery_type` do protocolo nativo da 99Food: 0 retirada, 1 plataforma, 2 loja. */
  delivery_type?: unknown
  /** O web lê `delivery_type` daqui; o card passa o pedido inteiro, então aceitamos os dois. */
  external_payload?: Record<string, unknown> | null
}

/**
 * Status para os quais existe uma ação da LOJA no iFood (confirm, readyToPickup,
 * dispatch). `delivered` e `cancelled` num pedido do iFood chegam por evento
 * (CON / CAN), nunca por botão — então o fluxo pra frente para em
 * `out_for_delivery` quando o pedido é do iFood.
 */
const IFOOD_ACIONAVEL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'preparing',
  'ready_to_pickup',
  'out_for_delivery',
])

export interface ProximaEtapa {
  status: OrderStatus
  /** Texto do botão grande. É uma AÇÃO ("Confirmar pedido"), não o nome do estado. */
  label: string
}

/**
 * A próxima etapa do pedido, ou `null` quando não há botão a mostrar (estado
 * terminal, ou pedido do marketplace esperando um evento dele).
 *
 * Ciente da modalidade: retirada pula "saiu para entrega" — o cliente busca no
 * balcão, então de "pronto" vai direto para "entregue".
 */
export function proximaEtapa(order: FlowOrder): ProximaEtapa | null {
  const isIfood = order.channel === 'ifood'
  const is99Food = order.channel === '99food'
  const isRetirada = order.fulfillment_type === 'pickup'
  const deliveryType = order.delivery_type ?? order.external_payload?.delivery_type
  const entrega99Food = deliveryType === 1 || deliveryType === '1'
  const entregaPropria99Food = deliveryType === 2 || deliveryType === '2'

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
      proxima = isRetirada || entregaPropria99Food
        ? { status: 'delivered', label: 'Entregue ao cliente' }
        // A API nativa não permite à loja despachar ou concluir uma entrega
        // feita pela 99Food. Esperamos o evento do entregador. Se a modalidade
        // ainda não veio no callback, também falhamos fechados.
        : is99Food && entrega99Food
          ? null
          : is99Food
            ? null
            : { status: 'out_for_delivery', label: 'Saiu para entrega' }
      break
    case 'out_for_delivery':
      proxima = { status: 'delivered', label: 'Concluir pedido' }
      break
    default:
      proxima = null
  }

  if (!proxima) return null

  // Pedido do iFood: só oferece a etapa se o iFood tem uma ação para ela. O
  // resto (concluir) é o iFood que dispara, quando o entregador finaliza.
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

export type OrigemTom = 'ifood' | '99food' | 'whatsapp' | 'web'

export interface Origem {
  label: string
  tom: OrigemTom
}

export function origemDoPedido(channel: string | null | undefined): Origem {
  if (channel === 'ifood') return { label: 'iFood', tom: 'ifood' }
  if (channel === '99food') return { label: '99Food', tom: '99food' }
  if (channel === 'whatsapp') return { label: 'WhatsApp', tom: 'whatsapp' }
  if (channel === 'balcao') return { label: 'Balcão', tom: 'web' }
  return { label: 'Site', tom: 'web' }
}
