import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play, Power } from 'lucide-react'
import type { StorePauseState } from '../electron-api'
import { useConfirmar } from './Confirmar'

/**
 * Pausar/retomar a loja pelo app da cozinha — cardápio próprio, iFood e 99Food.
 *
 * Só a ação por tempo indeterminado (fechar o cardápio próprio) pede
 * confirmação. Pausa temporária de marketplace e "Retomar" agem direto e
 * avisam o fato: um toque a mais, no meio do rush, custa mais que desfazer.
 * O estado do iFood e do 99Food custam chamadas às APIs deles, então só são
 * consultados aqui, ao abrir o painel e depois de cada ação — nunca no polling
 * de 10s dos pedidos.
 */

const OPCOES_PAUSA = [15, 30, 60, 120]

/** Mesmas 4 opções da tela de Integrações: 1=10min, 2=20min, 3=30min, 4=até o fim do dia. */
const OPCOES_PAUSA_99FOOD: { value: 1 | 2 | 3 | 4; label: string }[] = [
  { value: 1, label: '10min' },
  { value: 2, label: '20min' },
  { value: 3, label: '30min' },
  { value: 4, label: 'Fim do dia' },
]

interface Loja {
  id: string
  storeName: string | null
}

type Notify = (m: string, tipo?: 'info' | 'erro') => void

function horaCurta(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function rotuloDuracao(min: number): string {
  if (min < 60) return `${min} minutos`
  const h = min / 60
  return `${h} ${h === 1 ? 'hora' : 'horas'}`
}

function BlocoLoja({ loja, unica, notify, aoMudar }: {
  loja: Loja
  unica: boolean
  notify: Notify
  /** Diz ao painel se algo desta loja está pausado/fechado (null = sem dado). */
  aoMudar: (lojaId: string, algoPausado: boolean | null) => void
}) {
  const confirmar = useConfirmar()
  const [estado, setEstado] = useState<StorePauseState | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [falhou, setFalhou] = useState(false)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    setFalhou(false)
    try {
      const res = await window.api.getStorePauseState(loja.id)
      if (!res || res.ok === false) {
        setEstado(null)
        setFalhou(true)
        aoMudar(loja.id, null)
      } else {
        setEstado(res)
        aoMudar(
          loja.id,
          res.loja?.overrideAtivo === false || res.ifood?.pausada === true || res.food99?.pausada === true,
        )
      }
    } catch {
      setEstado(null)
      setFalhou(true)
      aoMudar(loja.id, null)
    } finally {
      setCarregando(false)
    }
  }, [loja.id, aoMudar])

  useEffect(() => { void Promise.resolve().then(carregar) }, [carregar])

  const nome = loja.storeName || 'Loja'

  async function agir(
    body: Parameters<typeof window.api.setStorePause>[0],
    aviso: string,
  ) {
    setOcupado(true)
    try {
      const res = await window.api.setStorePause(body, loja.id)
      if (!res.ok) { notify(res.error || 'Não deu para concluir · o servidor não confirmou a mudança', 'erro'); return }
      notify(aviso)
      await carregar()
    } catch {
      notify('Não deu para concluir · sem resposta do servidor', 'erro')
    } finally {
      setOcupado(false)
    }
  }

  async function fecharCardapioProprio() {
    const ok = await confirmar({
      titulo: `Fechar o cardápio próprio de ${nome}?`,
      descricao: 'Fica fechado até você reabrir, mesmo dentro do horário. Pedidos do Site e do WhatsApp deixam de entrar.',
      confirmarRotulo: 'Fechar cardápio',
      cancelarRotulo: 'Manter aberto',
      perigo: true,
    })
    if (ok) await agir({ alvo: 'loja', acao: 'pausar' }, 'Cardápio próprio fechado')
  }

  const lojaInfo = estado?.loja
  const overrideAtivo = lojaInfo?.overrideAtivo ?? true
  const dentroDoHorario = lojaInfo?.dentroDoHorario ?? true
  const lojaAberta = lojaInfo?.aberta ?? true // efetivo: chave geral E horário
  const lojaTexto = !overrideAtivo ? 'fechado · pausado'
    : !dentroDoHorario ? 'fechado · fora do horário'
    : 'aberto'
  const ifood = estado?.ifood
  const food99 = estado?.food99

  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2.5">
      {!unica && <p className="text-xs font-bold text-[var(--text)]">{nome}</p>}

      {carregando ? (
        <p className="text-xs text-[var(--text-muted)] flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> Consultando…
        </p>
      ) : falhou ? (
        <div className="space-y-2">
          <p className="text-xs text-[var(--danger)]">Não deu para consultar a loja · sem resposta do servidor</p>
          <button
            type="button"
            onClick={() => { setCarregando(true); void carregar() }}
            aria-label="Tentar de novo"
            className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)]"
          >
            Tentar de novo
          </button>
        </div>
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
                overrideAtivo
                  ? void fecharCardapioProprio()
                  : void agir({ alvo: 'loja', acao: 'retomar' }, 'Cardápio próprio reaberto, volta a seguir o horário')
              }
              aria-label={overrideAtivo ? 'Fechar cardápio próprio' : 'Reabrir cardápio próprio'}
              className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40 flex items-center gap-1"
            >
              {overrideAtivo ? <><Pause size={12} /> Fechar</> : <><Play size={12} /> Reabrir</>}
            </button>
          </div>
          {overrideAtivo && !dentroDoHorario && (
            <p className="text-[11px] text-[var(--text-muted)] -mt-1">
              A chave geral está ligada; fecha e abre sozinho pelo horário configurado.
            </p>
          )}

          {/* iFood */}
          {ifood?.conectada ? (
            ifood.pausada ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--primary)]">
                  iFood pausado{ifood.pausadaAte ? ` até ${horaCurta(ifood.pausadaAte)}` : ''}
                </span>
                <button
                  disabled={ocupado}
                  onClick={() => void agir({ alvo: 'ifood', acao: 'retomar' }, 'iFood retomado')}
                  aria-label="Retomar iFood"
                  className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--success)] hover:text-[var(--success)] disabled:opacity-40 flex items-center gap-1"
                >
                  <Play size={12} /> Retomar
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <span className="text-xs flex items-center gap-1.5">
                  <Power size={13} className={ifood.recebendo === false ? 'text-[var(--danger)]' : ifood.recebendo ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'} />
                  iFood: <b>{ifood.recebendo === false ? 'fechado' : ifood.recebendo ? 'recebendo' : 'conectado'}</b>
                  {ifood.recebendo === false && ifood.motivo ? <span className="text-[var(--text-muted)]"> · {ifood.motivo.toLowerCase()}</span> : null}
                </span>
                <span className="text-xs text-[var(--text-muted)] block">Pausar por:</span>
                <div className="flex gap-1.5 flex-wrap">
                  {OPCOES_PAUSA.map(min => (
                    <button
                      key={min}
                      disabled={ocupado}
                      onClick={() => {
                        const ate = new Date(Date.now() + min * 60_000).toISOString()
                        void agir({ alvo: 'ifood', acao: 'pausar', minutos: min }, `iFood pausado até ${horaCurta(ate)}`)
                      }}
                      aria-label={`Pausar iFood por ${rotuloDuracao(min)}`}
                      className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40"
                    >
                      {min < 60 ? `${min}min` : `${min / 60}h`}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <p className="text-xs text-[var(--text-muted)]">iFood não conectado nesta loja.</p>
          )}

          {/* 99Food */}
          {food99?.conectada ? (
            food99.pausada ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--primary)]">
                  {food99.subStatus === 3 ? '99Food fechado manualmente' : '99Food pausado'}
                </span>
                <button
                  disabled={ocupado}
                  onClick={() => void agir({ alvo: '99food', acao: 'retomar' }, '99Food retomado')}
                  aria-label="Retomar 99Food"
                  className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--success)] hover:text-[var(--success)] disabled:opacity-40 flex items-center gap-1"
                >
                  <Play size={12} /> Retomar
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <span className="text-xs flex items-center gap-1.5">
                  <Power size={13} className="text-[var(--success)]" />
                  99Food: <b>recebendo</b>
                </span>
                <span className="text-xs text-[var(--text-muted)] block">Pausar por:</span>
                <div className="flex gap-1.5 flex-wrap">
                  {OPCOES_PAUSA_99FOOD.map(opcao => (
                    <button
                      key={opcao.value}
                      disabled={ocupado}
                      onClick={() => void agir({ alvo: '99food', acao: 'pausar', pauseTime: opcao.value }, `99Food pausado (${opcao.label.toLowerCase()})`)}
                      aria-label={`Pausar 99Food: ${opcao.label.toLowerCase()}`}
                      className="min-h-10 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40"
                    >
                      {opcao.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <p className="text-xs text-[var(--text-muted)]">99Food não conectado nesta loja.</p>
          )}
        </>
      )}
    </div>
  )
}

export function StorePausePanel({ stores, onClose, notify, aoMudarEstado }: {
  stores: Loja[]
  onClose: () => void
  notify: (message: string, tipo?: 'info' | 'erro') => void
  /** Chamado quando muda se há algo pausado/fechado em qualquer loja (cardápio próprio, iFood ou 99Food). */
  aoMudarEstado?: (algoPausado: boolean) => void
}) {
  const porLoja = useRef<Record<string, boolean | null>>({})
  const aoMudarRef = useRef(aoMudarEstado)
  useEffect(() => { aoMudarRef.current = aoMudarEstado })

  const registrar = useCallback((lojaId: string, algoPausado: boolean | null) => {
    porLoja.current[lojaId] = algoPausado
    aoMudarRef.current?.(Object.values(porLoja.current).some(v => v === true))
  }, [])

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute right-3 top-12 w-80 max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-lg p-3 space-y-2"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-sm font-bold text-[var(--text)]">Pausar loja</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar painel de pausa"
            className="min-h-9 text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-muted)]"
          >
            Fechar
          </button>
        </div>
        {stores.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] px-1">Nenhuma loja configurada.</p>
        )}
        {stores.map(loja => (
          <BlocoLoja key={loja.id} loja={loja} unica={stores.length === 1} notify={notify} aoMudar={registrar} />
        ))}
      </div>
    </div>
  )
}
