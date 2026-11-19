import { useEffect, useRef, useState } from 'react'
import type { IfoodCancelReason } from '../electron-api'

/** Nome do marketplace pra tela — só isto muda entre os dois canais. */
function nomeMarketplace(channel: string): string {
  return channel === '99food' ? '99Food' : 'iFood'
}

/**
 * Diálogo de cancelamento de pedido de marketplace (iFood, 99Food) — espelho
 * do componente do painel web. O motivo tem que sair da lista aceita para
 * AQUELE pedido (exigência da homologação): no iFood ela é buscada a cada
 * abertura, sem cache, porque muda conforme o estado do pedido; no 99Food é
 * fixa (enum da spec), mas o backend devolve as duas do mesmo jeito — o
 * componente não precisa saber a diferença.
 */
export function CancelIfoodDialog({
  orderId,
  channel,
  connectionId,
  onClose,
  onRequested,
  notify,
}: {
  orderId: string
  channel: string
  connectionId?: string
  onClose: () => void
  onRequested: () => void
  notify: (message: string, tipo?: 'info' | 'erro') => void
}) {
  const marketplace = nomeMarketplace(channel)
  const [reasons, setReasons] = useState<IfoodCancelReason[]>([])
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  // `onClose`/`notify` são recriadas a cada render do App (a cada ~7 s). Como
  // dependência do efeito, refaziam a busca e devolviam a seleção ao primeiro
  // motivo — o operador podia cancelar com o motivo errado.
  const onCloseRef = useRef(onClose)
  const notifyRef = useRef(notify)
  useEffect(() => { onCloseRef.current = onClose; notifyRef.current = notify })

  useEffect(() => {
    let cancelled = false
    window.api.getIfoodCancelReasons(orderId, connectionId)
      .then(res => {
        if (cancelled) return
        if (!res.ok) { notifyRef.current(res.error || `Não deu para carregar os motivos · o ${marketplace} não respondeu`, 'erro'); onCloseRef.current(); return }
        setReasons(res.reasons ?? [])
        setCode(res.reasons?.[0]?.code ?? '')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `marketplace` deriva de `channel`, que não muda com o pedido aberto.
  }, [orderId, connectionId])

  async function submit() {
    const reason = reasons.find(r => r.code === code)
    if (!reason) return
    setSending(true)
    const res = await window.api.requestIfoodCancel(orderId, reason.code, reason.description, connectionId)
    setSending(false)
    if (!res.ok) { notify(res.error || `Não deu para cancelar · o ${marketplace} recusou o pedido`, 'erro'); return }
    notify(`Cancelamento enviado ao ${marketplace}`)
    onRequested()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Cancelar pedido do ${marketplace}`}
        className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-md p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-base">Cancelar pedido do {marketplace}</h3>

        {loading ? (
          <p className="text-xs text-[var(--text-muted)]">Buscando os motivos no {marketplace}…</p>
        ) : reasons.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            O {marketplace} não ofereceu nenhum motivo de cancelamento para este pedido agora.
          </p>
        ) : (
          <>
            <label className="block text-xs text-[var(--text-muted)]">
              Motivo (escolhido entre os que o {marketplace} aceita para este pedido)
              <select
                value={code}
                onChange={e => setCode(e.target.value)}
                className="mt-1 w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-sm text-[var(--text)]"
              >
                {reasons.map(reason => (
                  <option key={reason.code} value={reason.code}>{reason.description}</option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-[var(--text-muted)]">
              O {marketplace} pode recusar ou abrir disputa. O pedido só sai do kanban quando ele confirmar.
            </p>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            aria-label="Manter pedido"
            className="min-h-11 text-sm px-4 py-2 rounded-lg border border-[var(--border)] text-[var(--text)]"
          >
            Manter pedido
          </button>
          <button
            onClick={submit}
            disabled={sending || loading || !code}
            aria-label={`Pedir cancelamento ao ${marketplace}`}
            className="min-h-11 text-sm px-4 py-2 rounded-lg border border-red-500/40 text-[var(--danger)] disabled:opacity-40"
          >
            {sending ? 'Enviando…' : 'Pedir cancelamento'}
          </button>
        </div>
      </div>
    </div>
  )
}
