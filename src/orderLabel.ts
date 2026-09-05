/**
 * O número do pedido como a cozinha, o cliente e a loja o chamam.
 *
 * Cópia enxuta de `lib/order-label.ts` do app web (o projeto já mantém tipos
 * duplicados entre web e desktop). Puro: sem acesso a banco, serve no renderer
 * e no processo principal do Electron.
 *
 * - Pedido de marketplace (iFood, 99Food): usa o número DELE — é o que o
 *   cliente informa e o que aparece no app do lojista. Nunca o nosso
 *   sequencial (que nem é atribuído a estes pedidos).
 * - Pedido próprio: loja + sequencial, "01012" (dois dígitos de loja, três de
 *   pedido). Cresce acima de 999 em vez de reiniciar.
 * - Sem o número da loja no payload, mostra o sequencial sozinho.
 * - Último recurso (pedido anterior ao backfill): prefixo do uuid.
 */

export interface LabelableOrder {
  id: string
  channel?: string | null
  order_number?: number | null
  ifood_display_id?: string | null
  opendelivery_display_id?: string | null
  stores?: { store_number: number } | null
}

export function formatOrderNumber(storeNumber: number, orderNumber: number): string {
  return `${String(storeNumber).padStart(2, '0')}${String(orderNumber).padStart(3, '0')}`
}

export function orderLabel(order: LabelableOrder): string {
  if (order.channel === 'ifood') {
    return order.ifood_display_id ?? order.id.slice(0, 8).toUpperCase()
  }
  if (order.channel === '99food') {
    return order.opendelivery_display_id ?? order.id.slice(0, 8).toUpperCase()
  }

  const storeNumber = order.stores?.store_number
  if (storeNumber && order.order_number) return formatOrderNumber(storeNumber, order.order_number)
  if (order.order_number) return String(order.order_number)

  return order.id.slice(0, 8).toUpperCase()
}
