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

  // A contagem de PREPARO só vale enquanto o pedido está sendo preparado —
  // depois de "pronto" ela somava tempo de pronto + entrega e aparecia como
  // "atrasado" num pedido que já tinha saído.
  const emPreparo = ['pending', 'awaiting_payment', 'paid', 'preparing'].includes(order.status)
  if (!emPreparo) {
    return { terminal: false, totalMin: null, alvoISO: null, restanteMin: null, atrasado: false }
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

export type NivelUrgencia = 'fresca' | 'aquecendo' | 'atrasada'

interface UrgenciaOrder extends TimingOrder {
  /** Limites por etapa do pedido próprio (carimbados na listagem). */
  confirm_target_minutes?: number | null
  prep_target_minutes?: number | null
  ready_target_minutes?: number | null
}

/**
 * Nível de urgência do pedido, para a COR do cartão (faixa lateral + fundo).
 * O prazo depende da ETAPA atual:
 *
 *   iFood         → sempre o horário prometido (`delivery.deliveryDateTime`), o
 *                   prazo único que o pedido inteiro corre, como no Gestor.
 *   Pedido próprio → soma dos limites das etapas ATÉ a atual, a partir de
 *                   `created_at` — "devia ter saído até confirmar + preparar +
 *                   aguardar minutos depois de entrar". Só depende de
 *                   `created_at`, então não escorrega com outros writes na linha.
 *
 *   atrasado                    → 'atrasada'   (vermelho)
 *   resta ≤ metade da janela    → 'aquecendo'  (amarelo)  — a regra do iFood
 *   resta  > metade da janela   → 'fresca'     (verde)
 *
 * `null` (cartão neutro) quando: terminal, já saiu para entrega, iFood sem
 * horário no payload, ou pedido próprio sem nenhum limite de etapa configurado.
 */
export function nivelUrgencia(order: UrgenciaOrder, agora: number = Date.now()): NivelUrgencia | null {
  if (order.status === 'delivered' || order.status === 'cancelled') return null
  if (order.status === 'out_for_delivery') return null
  // Pedido do iFood: quando a cozinha marca "pronto", o resto é com o iFood
  // (o motoboy). Não faz sentido pintar de vermelho o que a cozinha já
  // terminou e não controla — a urgência de preparo para aqui.
  if (order.channel === 'ifood' && order.status === 'ready_to_pickup') return null

  const criadoMs = new Date(order.created_at).getTime()
  let alvoMs: number | null = null

  if (order.channel === 'ifood') {
    const iso = ifoodDeliveryDateTime(order.external_payload)
    alvoMs = iso ? new Date(iso).getTime() : null
  } else {
    const confirmar = Math.max(0, order.confirm_target_minutes ?? 0)
    const preparar = Math.max(0, order.prep_target_minutes ?? 0)
    const aguardar = Math.max(0, order.ready_target_minutes ?? 0)
    // Soma cumulativa até a etapa atual.
    const janelaMin =
      order.status === 'ready_to_pickup' ? confirmar + preparar + aguardar
      : order.status === 'preparing'     ? confirmar + preparar
      : confirmar // pending / awaiting_payment / paid
    if (janelaMin > 0) alvoMs = criadoMs + janelaMin * 60000
  }

  if (alvoMs == null) return null

  const restanteMin = Math.round((alvoMs - agora) / 60000)
  if (restanteMin < 0) return 'atrasada'
  const janelaMin = (alvoMs - criadoMs) / 60000
  const metade = janelaMin > 0 ? janelaMin / 2 : 10
  return restanteMin <= metade ? 'aquecendo' : 'fresca'
}

interface FilaOrder extends UrgenciaOrder {
  acknowledged_at?: string | null
}

const PESO_URGENCIA: Record<NivelUrgencia, number> = { atrasada: 0, aquecendo: 1, fresca: 2 }

/**
 * Ordem dos cartões DENTRO de uma coluna do kanban — a fila que a cozinha
 * ataca de cima para baixo:
 *
 *   1. Pendência primeiro — cartão ainda não reconhecido (ninguém abriu).
 *   2. Urgência — atrasada → aquecendo → fresca → sem prazo.
 *   3. Mais velho primeiro.
 *
 * A coluna "Concluído" (pedidos terminais) é a exceção: ali o que terminou por
 * último fica no topo, para conferir rápido o que acabou de sair.
 *
 * Comparador para o `.sort()` da lista já filtrada por coluna.
 */
export function compararFilaCozinha(a: FilaOrder, b: FilaOrder, agora: number = Date.now()): number {
  const termA = a.status === 'delivered' || a.status === 'cancelled'
  const termB = b.status === 'delivered' || b.status === 'cancelled'
  if (termA && termB) {
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  }

  const pendA = a.acknowledged_at ? 1 : 0
  const pendB = b.acknowledged_at ? 1 : 0
  if (pendA !== pendB) return pendA - pendB

  const nA = nivelUrgencia(a, agora)
  const nB = nivelUrgencia(b, agora)
  const urgA = nA ? PESO_URGENCIA[nA] : 3
  const urgB = nB ? PESO_URGENCIA[nB] : 3
  if (urgA !== urgB) return urgA - urgB

  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
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

/**
 * Texto do entregador no card — o que interessa é QUANTO FALTA, não o nome.
 */
export function textoEntregador(d: { estagio: 'a_caminho' | 'na_loja' | 'coletou'; pickupEtaMin?: number | null }): string {
  if (d.estagio === 'na_loja') return 'Entregador na loja'
  if (d.estagio === 'coletou') return 'Entregador saiu com o pedido'
  if (d.pickupEtaMin != null) return `Entregador chega em ${d.pickupEtaMin} min`
  return 'Entregador a caminho'
}

export function horaLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  })
}
