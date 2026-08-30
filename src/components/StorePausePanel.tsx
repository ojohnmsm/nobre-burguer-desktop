import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pause, Play, Power } from 'lucide-react'
import type { StorePauseState } from '../electron-api'

/**
 * Pausar/retomar a loja pelo app da cozinha — cardápio próprio e iFood.
 *
 * Toda ação passa por `window.confirm` (mesmo padrão de remover uma loja em
 * Settings). O estado do iFood custa duas chamadas à API deles, então só é
 * consultado aqui, ao abrir o painel e depois de cada ação — nunca no polling
 * de 10s dos pedidos.
 */

const OPCOES_PAUSA = [15, 30, 60, 120]

interface Loja {
  id: string
  storeName: string | null
}

function BlocoLoja({ loja, unica, notify }: { loja: Loja; unica: boolean; notify: (m: string) => void }) {
  const [estado, setEstado] = useState<StorePauseState | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    const res = await window.api.getStorePauseState(loja.id)
    setEstado(res)
    setCarregando(false)
  }, [loja.id])

  useEffect(() => { void carregar() }, [carregar])

  async function agir(
    body: { alvo: 'loja' | 'ifood'; acao: 'pausar' | 'retomar'; minutos?: number },
    confirmacao: string,
  ) {
    if (!window.confirm(confirmacao)) return
    setOcupado(true)
    try {
      const res = await window.api.setStorePause(body, loja.id)
      if (!res.ok) { notify(res.error || 'Não foi possível concluir'); return }
      await carregar()
    } finally {
      setOcupado(false)
    }
  }

  const nome = loja.storeName || 'Loja'
  const lojaInfo = estado?.loja
  const overrideAtivo = lojaInfo?.overrideAtivo ?? true
  const dentroDoHorario = lojaInfo?.dentroDoHorario ?? true
  const lojaAberta = lojaInfo?.aberta ?? true // efetivo: chave geral E horário
  const lojaTexto = !overrideAtivo ? 'fechado · pausado'
    : !dentroDoHorario ? 'fechado · fora do horário'
    : 'aberto'
  const ifood = estado?.ifood

  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2.5">
      {!unica && <p className="text-xs font-bold text-[var(--text)]">{nome}</p>}

      {carregando ? (
        <p className="text-xs text-[var(--text-muted)] flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> Consultando…
        </p>
      ) : (
        <>
          {/* Cardápio próprio — o "aberto" só vale com a chave geral ligada E
              dentro do horário; o texto diz qual dos dois está fechando. */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs flex items-center gap-1.5">
              <Power size={13} className={
                lojaAberta ? 'text-[var(--success)]'
                : overrideAtivo ? 'text-[var(--primary)]'
                : 'text-[var(--danger)]'
              } />
              Cardápio próprio: <b>{lojaTexto}</b>
            </span>
            <button
              disabled={ocupado}
              onClick={() =>
                agir(
                  { alvo: 'loja', acao: overrideAtivo ? 'pausar' : 'retomar' },
                  overrideAtivo
                    ? `Fechar o cardápio próprio de ${nome}? Fica fechado até você reabrir — mesmo dentro do horário.`
                    : `Reabrir o cardápio próprio de ${nome}? Volta a seguir o horário de funcionamento.`,
                )
              }
              className="text-[11px] px-2 py-1 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40 flex items-center gap-1"
            >
              {overrideAtivo ? <><Pause size={11} /> Fechar</> : <><Play size={11} /> Reabrir</>}
            </button>
          </div>
          {overrideAtivo && !dentroDoHorario && (
            <p className="text-[10px] text-[var(--text-xmuted)] -mt-1">
              A chave geral está ligada; fecha e abre sozinho pelo horário configurado.
            </p>
          )}

          {/* iFood */}
          {ifood?.conectada ? (
            ifood.pausada ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--primary)]">
                  iFood: pausado{ifood.pausadaAte ? ` até ${new Date(ifood.pausadaAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
                <button
                  disabled={ocupado}
                  onClick={() => agir({ alvo: 'ifood', acao: 'retomar' }, `Retomar ${nome} no iFood agora?`)}
                  className="text-[11px] px-2 py-1 rounded-lg border border-[var(--border)] hover:border-[var(--success)] hover:text-[var(--success)] disabled:opacity-40 flex items-center gap-1"
                >
                  <Play size={11} /> Retomar
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <span className="text-xs flex items-center gap-1.5">
                  <Power size={13} className={ifood.recebendo === false ? 'text-[var(--danger)]' : ifood.recebendo ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'} />
                  iFood: <b>{ifood.recebendo === false ? 'fechado' : ifood.recebendo ? 'recebendo' : 'conectado'}</b>
                  {ifood.recebendo === false && ifood.motivo ? <span className="text-[var(--text-muted)]"> · {ifood.motivo.toLowerCase()}</span> : null}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] block">Pausar por:</span>
                <div className="flex gap-1.5 flex-wrap">
                  {OPCOES_PAUSA.map(min => (
                    <button
                      key={min}
                      disabled={ocupado}
                      onClick={() =>
                        agir(
                          { alvo: 'ifood', acao: 'pausar', minutos: min },
                          `Pausar ${nome} no iFood por ${min < 60 ? `${min} minutos` : `${min / 60}h`}?`,
                        )
                      }
                      className="text-[11px] px-2 py-1 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40"
                    >
                      {min < 60 ? `${min}min` : `${min / 60}h`}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <p className="text-[11px] text-[var(--text-xmuted)]">iFood não conectado nesta loja.</p>
          )}
        </>
      )}
    </div>
  )
}

export function StorePausePanel({ stores, onClose, notify }: {
  stores: Loja[]
  onClose: () => void
  notify: (message: string) => void
}) {
  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute right-3 top-12 w-80 max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-lg p-3 space-y-2"
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm font-bold text-[var(--text)] px-1">Pausar loja</p>
        {stores.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] px-1">Nenhuma loja configurada.</p>
        )}
        {stores.map(loja => (
          <BlocoLoja key={loja.id} loja={loja} unica={stores.length === 1} notify={notify} />
        ))}
      </div>
    </div>
  )
}
