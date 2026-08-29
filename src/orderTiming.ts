/**
 * Tempo de preparo do pedido — cópia de `lib/order-timing.ts` do app web (o
 * projeto duplica utilitário puro entre web e desktop).
 *
 * iFood: alvo = `external_payload.delivery.deliveryDateTime` (o iFood define).
 * Pedido próprio: `created_at + prepTargetMinutes` (0 = sem contagem).
 * Terminal: congela; devolve o tempo total.
 */

export interface TimingOrder {
  channel?: string | null
  status: string
  created_at: string
  updated_at: string
  external_payload?: Record<string, unknown> | null
}

export interface PreparoInfo {
  terminal: boolean
  totalMin: number | null
  alvoISO: string | null
  restanteMin: number | null
  atrasado: boolean
}

function ifoodDeliveryDateTime(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload || typeof payload !== 'object') return null
  const delivery = (payload as { delivery?: { deliveryDateTime?: unknown } }).delivery
  const dt = delivery?.deliveryDateTime
  return typeof dt === 'string' && !Number.isNaN(Date.parse(dt)) ? dt : null
}

export function preparoInfo(
  order: TimingOrder,
  prepTargetMinutes: number,
  agora: number = Date.now()
): PreparoInfo {
  const isTerminal = order.status === 'delivered' || order.status === 'cancelled'

  if (isTerminal) {
    const totalMin = Math.max(
      0,
      Math.round((new Date(order.updated_at).getTime() - new Date(order.created_at).getTime()) / 60000)
    )
    return { terminal: true, totalMin, alvoISO: null, restanteMin: null, atrasado: false }
  }

  let alvoISO: string | null = null
  if (order.channel === 'ifood') {
    alvoISO = ifoodDeliveryDateTime(order.external_payload)
  } else if (prepTargetMinutes > 0) {
    alvoISO = new Date(new Date(order.created_at).getTime() + prepTargetMinutes * 60000).toISOString()
  }

  if (!alvoISO) {
    return { terminal: false, totalMin: null, alvoISO: null, restanteMin: null, atrasado: false }
  }

  const restanteMin = Math.round((new Date(alvoISO).getTime() - agora) / 60000)
  return { terminal: false, totalMin: null, alvoISO, restanteMin, atrasado: restanteMin < 0 }
}

const ICONE_VEICULO: Record<string, string> = {
  BICYCLE: '🚴', MOTORBIKE: '🏍️', MOTORCYCLE: '🏍️', CAR: '🚗', WALKER: '🚶', VAN: '🚐',
}

export function iconeVeiculo(v: string | null | undefined): string {
  return (v && ICONE_VEICULO[v.toUpperCase()]) || '📦'
}

export function labelEstagioEntregador(e: 'a_caminho' | 'na_loja' | 'coletou'): string {
  return e === 'na_loja' ? 'na loja' : e === 'coletou' ? 'coletou' : 'a caminho da loja'
}

export function horaLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  })
}
