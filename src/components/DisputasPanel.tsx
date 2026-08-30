import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { IfoodDispute } from '../electron-api'

/**
 * Disputas do iFood (Plataforma de Negociação) esperando resposta da loja.
 *
 * Sem resposta até `expiresAt`, o iFood decide sozinho — normalmente reembolsa
 * o cliente, e o dinheiro sai da conta da loja. Por isso o relógio é o
 * elemento mais destacado, e o painel fica no topo do kanban, não escondido.
 */
function tempoRestante(expiresAt: string | null, agora: number): { texto: string; urgente: boolean } {
  if (!expiresAt) return { texto: 'sem prazo informado', urgente: false }
  const restaMs = new Date(expiresAt).getTime() - agora
  if (restaMs <= 0) return { texto: 'prazo esgotado', urgente: true }
  const minutos = Math.floor(restaMs / 60000)
  if (minutos < 60) return { texto: `${minutos} min restantes`, urgente: minutos < 30 }
  return { texto: `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')} restantes`, urgente: false }
}

export function DisputasPanel({ notify }: { notify: (message: string) => void }) {
  const [disputas, setDisputas] = useState<IfoodDispute[]>([])
  const [carregando, setCarregando] = useState(true)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [agora, setAgora] = useState(() => Date.now())

  const carregar = useCallback(async () => {
    try {
      const data = await window.api.getIfoodDisputes()
      setDisputas(data?.disputas ?? [])
    } catch {
      // silencioso — não deve travar o resto do app
    } finally {
      setCarregando(false)
    }
  }, [])

  useEffect(() => {
    void carregar()
    const busca = setInterval(() => void carregar(), 60_000)
    const relogio = setInterval(() => setAgora(Date.now()), 30_000)
    return () => { clearInterval(busca); clearInterval(relogio) }
  }, [carregar])

  async function responder(disputa: IfoodDispute, resposta: 'accept' | 'reject') {
    let motivo: string | null = null
    if (resposta === 'reject') {
      motivo = window.prompt('Motivo da recusa (o iFood exige):')?.trim() || null
      if (!motivo) return
    }
    setOcupado(disputa.disputeId)
    try {
      const res = await window.api.respondIfoodDispute(disputa.disputeId, resposta, motivo, disputa.connectionId)
      if (!res.ok) { notify(res.error || 'Não foi possível responder a disputa'); return }
      notify(resposta === 'accept' ? 'Disputa aceita' : 'Disputa recusada')
      await carregar()
    } finally {
      setOcupado(null)
    }
  }

  if (carregando || disputas.length === 0) return null

  return (
    <div className="px-3 py-2.5 bg-red-500/10 border-b border-red-500/30 flex-shrink-0 space-y-2">
      <p className="text-xs font-bold text-[var(--danger)] flex items-center gap-1.5">
        <AlertTriangle size={13} />
        {disputas.length === 1 ? 'Uma contestação do iFood aguarda resposta' : `${disputas.length} contestações do iFood aguardam resposta`}
      </p>
      <p className="text-[11px] text-[var(--text-muted)]">
        Sem resposta no prazo, o iFood decide sozinho — normalmente reembolsa o cliente.
      </p>
      {disputas.map(disputa => {
        const prazo = tempoRestante(disputa.expiresAt, agora)
        return (
          <div key={disputa.id} className="rounded-lg border border-red-500/30 bg-[var(--card)] px-2.5 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs">
                {disputa.storeLabel && <span className="text-[var(--text-muted)]">{disputa.storeLabel} · </span>}
                {disputa.displayId && <span className="font-bold">#{disputa.displayId} · </span>}
                {disputa.action === 'CANCELLATION' ? 'Cliente pediu cancelamento' : disputa.action || 'Contestação'}
              </span>
              <span className={`text-[11px] font-bold ${prazo.urgente ? 'text-[var(--danger)]' : 'text-[var(--primary)]'}`}>
                {prazo.texto}
              </span>
            </div>
            {disputa.timeoutAction && (
              <p className="text-[10px] text-[var(--text-muted)]">
                Se ninguém responder: {disputa.timeoutAction === 'REJECT_CANCELLATION' ? 'o iFood recusa automaticamente' : disputa.timeoutAction}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => void responder(disputa, 'accept')}
                disabled={ocupado === disputa.disputeId}
                className="flex-1 text-[11px] px-2 py-1 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40"
              >
                {ocupado === disputa.disputeId ? <Loader2 size={11} className="animate-spin mx-auto" /> : 'Aceitar'}
              </button>
              <button
                onClick={() => void responder(disputa, 'reject')}
                disabled={ocupado === disputa.disputeId}
                className="flex-1 text-[11px] px-2 py-1 rounded-lg border border-red-500/40 text-[var(--danger)] disabled:opacity-40"
              >
                Recusar
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
