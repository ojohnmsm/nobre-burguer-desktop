import { useEffect, useState } from 'react'
import type { IfoodCancelReason } from '../electron-api'

/**
 * Diálogo de cancelamento de pedido do iFood — espelho do componente do painel
 * web. O motivo tem que sair da lista que o próprio iFood devolve para AQUELE
 * pedido naquele momento (exigência da homologação); por isso a lista é buscada
 * ao abrir, toda vez, sem cache.
 */
export function CancelIfoodDialog({
  orderId,
  connectionId,
  onClose,
  onRequested,
  notify,
}: {
  orderId: string
  connectionId?: string
  onClose: () => void
  onRequested: () => void
  notify: (message: string) => void
}) {
  const [reasons, setReasons] = useState<IfoodCancelReason[]>([])
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.getIfoodCancelReasons(orderId, connectionId)
      .then(res => {
        if (cancelled) return
        if (!res.ok) { notify(res.error || 'Não foi possível carregar os motivos'); onClose(); return }
        setReasons(res.reasons ?? [])
        setCode(res.reasons?.[0]?.code ?? '')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orderId, connectionId, onClose, notify])

  async function submit() {
    const reason = reasons.find(r => r.code === code)
    if (!reason) return
    setSending(true)
    const res = await window.api.requestIfoodCancel(orderId, reason.code, reason.description, connectionId)
    setSending(false)
    if (!res.ok) { notify(res.error || 'O iFood recusou o cancelamento'); return }
    notify('Cancelamento pedido ao iFood')
    onRequested()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-md p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-sm">Cancelar pedido do iFood</h3>

        {loading ? (
          <p className="text-xs text-[var(--text-muted)]">Carregando motivos do iFood…</p>
        ) : reasons.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            O iFood não ofereceu nenhum motivo de cancelamento para este pedido agora.
          </p>
        ) : (
          <>
            <label className="block text-xs text-[var(--text-muted)]">
              Motivo (escolhido entre os que o iFood aceita para este pedido)
              <select
                value={code}
                onChange={e => setCode(e.target.value)}
                className="mt-1 w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)]"
              >
                {reasons.map(reason => (
                  <option key={reason.code} value={reason.code}>{reason.description}</option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-[var(--text-muted)]">
              O iFood pode recusar ou abrir disputa. O pedido só sai do kanban quando ele confirmar.
            </p>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text)]">
            Voltar
          </button>
          <button
            onClick={submit}
            disabled={sending || loading || !code}
            className="text-xs px-3 py-1.5 rounded-lg border border-red-500/40 text-[var(--danger)] disabled:opacity-40"
          >
            {sending ? 'Enviando…' : 'Pedir cancelamento'}
          </button>
        </div>
      </div>
    </div>
  )
}
