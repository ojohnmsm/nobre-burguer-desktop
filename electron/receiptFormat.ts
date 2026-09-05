/**
 * Rótulo do pedido e origem, para a comanda impressa — versão do PROCESSO
 * PRINCIPAL (o renderer tem a sua em `src/orderLabel.ts` / `src/orderFlow.ts`).
 * São ~20 linhas puras; o projeto já duplica utilitário assim entre web e
 * desktop, e o build do Electron separa main de renderer.
 */

export interface LabelableOrder {
  id: string
  channel?: string | null
  order_number?: number | null
  ifood_display_id?: string | null
  opendelivery_display_id?: string | null
  stores?: { store_number: number } | null
}

export function orderLabel(order: LabelableOrder): string {
  if (order.channel === 'ifood') {
    return order.ifood_display_id ?? order.id.slice(0, 8).toUpperCase()
  }
  if (order.channel === '99food') {
    return order.opendelivery_display_id ?? order.id.slice(0, 8).toUpperCase()
  }
  const storeNumber = order.stores?.store_number
  if (storeNumber && order.order_number) {
    return `${String(storeNumber).padStart(2, '0')}${String(order.order_number).padStart(3, '0')}`
  }
  if (order.order_number) return String(order.order_number)
  return order.id.slice(0, 8).toUpperCase()
}

/** Texto curto da origem, para a linha de destaque na comanda. */
export function origemLabel(channel: string | null | undefined): string {
  if (channel === 'ifood') return 'IFOOD'
  if (channel === '99food') return '99FOOD'
  if (channel === 'whatsapp') return 'WHATSAPP'
  return 'SITE'
}
