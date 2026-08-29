export type OrderStatus =
  | 'pending' | 'awaiting_payment' | 'paid'
  | 'preparing' | 'ready_to_pickup' | 'out_for_delivery'
  | 'delivered' | 'cancelled'

export interface AddonSelection {
  groupName: string
  selectedOptions: { name: string; price_cents: number }[]
}

export interface OrderItem {
  id: string
  product_name: string
  quantity: number
  subtotal_cents: number
  notes: string | null
  addon_selections: AddonSelection[]
}

export type FulfillmentType = 'delivery' | 'pickup'
export type OrderChannel = 'web' | 'whatsapp' | 'ifood'

export interface Order {
  id: string
  /**
   * De qual loja este pedido veio, quando o computador atende mais de uma.
   * Vem do aplicativo, não do servidor — é o identificador da conexão local,
   * e é ele que faz "em preparo" voltar para o servidor certo.
   */
  connectionId?: string
  storeLabel?: string
  customer_name: string
  customer_phone: string
  fulfillment_type: FulfillmentType
  pickup_address: string | null
  address: string | null
  address_number: string | null
  address_complement: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
  subtotal_cents: number
  delivery_fee_cents: number
  total_cents: number
  payment_method: string
  change_for_cents: number | null
  status: OrderStatus
  notes: string | null
  channel: OrderChannel
  /** Sequencial da loja ("01012" com o store_number). Nulo em pedido do iFood. */
  order_number: number | null
  /** Número curto do iFood, o que o cliente informa. Nulo fora do canal iFood. */
  ifood_display_id: string | null
  ifood_order_id: string | null
  /** Código que o entregador informa ao retirar o pedido na loja. */
  ifood_pickup_code: string | null
  /** Vem no join da listagem — o número curto da loja, para montar "01012". */
  stores?: { store_number: number } | null
  acknowledged_at: string | null
  created_at: string
  order_items: OrderItem[]
}

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending:          'Pendente',
  awaiting_payment: 'Aguardando pag.',
  paid:             'Pago',
  preparing:        'Preparando',
  ready_to_pickup:  'Pronto',
  out_for_delivery: 'Saiu p/ entrega',
  delivered:        'Entregue',
  cancelled:        'Cancelado',
}

export const PAYMENT_LABELS: Record<string, string> = {
  pix:          'Pix',
  cash:         'Dinheiro',
  credit_card:  'Crédito',
  debit_card:   'Débito',
  meal_voucher: 'Vale Ref.',
  food_voucher: 'Vale Alim.',
}

export const KANBAN_COLUMNS: { id: string; label: string; statuses: OrderStatus[]; accent: string }[] = [
  // Uma coluna por etapa do fluxo: recebido -> em preparo -> pronto -> saiu ->
  // concluído. "Pronto" (ready_to_pickup) tem coluna própria porque é a etapa
  // entre confirmar e despachar — e o ciclo do iFood depende dela.
  // Online pendente não chega ao PDV: o servidor só o libera após o Mercado
  // Pago aprovar. Mantemos o tipo para que pedidos antigos sigam legíveis no histórico.
  { id: 'new',      label: 'Novos',      statuses: ['pending','paid'],          accent: '#f59e0b' },
  { id: 'prep',     label: 'Em preparo', statuses: ['preparing'],               accent: '#3b82f6' },
  { id: 'ready',    label: 'Pronto',     statuses: ['ready_to_pickup'],         accent: '#14b8a6' },
  { id: 'delivery', label: 'Na entrega', statuses: ['out_for_delivery'],        accent: '#a855f7' },
  { id: 'done',     label: 'Concluído',  statuses: ['delivered','cancelled'],   accent: '#6b7280' },
]

export function fmtMoney(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 1)  return 'agora'
  if (diff < 60) return `${diff}min`
  return `${Math.floor(diff / 60)}h${diff % 60 > 0 ? String(diff % 60).padStart(2, '0') : ''}`
}
