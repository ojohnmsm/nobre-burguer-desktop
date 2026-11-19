import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Confirmação e pedido de texto no visual dos modais do app. Substitui
 * `window.confirm`/`window.prompt`: o `prompt` nem existe no Electron, e os dois
 * bloqueiam a tela inteira do tablet. Uma janela por vez — pedidos novos entram
 * na fila e abrem quando a anterior fecha.
 */

export interface OpcoesConfirmar {
  titulo: string
  descricao?: ReactNode
  confirmarRotulo: string
  cancelarRotulo?: string
  /** Ação que não se desfaz ou custa dinheiro: o foco inicial fica em desistir. */
  perigo?: boolean
}

export interface OpcoesPedirTexto {
  titulo: string
  descricao?: ReactNode
  rotuloCampo: string
  obrigatorio?: boolean
  confirmarRotulo: string
  perigo?: boolean
}

type Pedido =
  | { tipo: 'confirmar'; opcoes: OpcoesConfirmar; resolver: (v: boolean) => void }
  | { tipo: 'texto'; opcoes: OpcoesPedirTexto; resolver: (v: string | null) => void }

type Contexto = {
  enfileirar: (p: Pedido) => void
}

const ConfirmarContext = createContext<Contexto | null>(null)

export function ConfirmarProvider({ children }: { children: ReactNode }) {
  const [fila, setFila] = useState<Pedido[]>([])

  const enfileirar = useCallback((p: Pedido) => {
    setFila(atual => [...atual, p])
  }, [])

  const atual = fila[0] ?? null
  const valor = useMemo<Contexto>(() => ({ enfileirar }), [enfileirar])

  function encerrar() {
    setFila(f => f.slice(1))
  }

  return (
    <ConfirmarContext.Provider value={valor}>
      {children}
      {atual && atual.tipo === 'confirmar' && (
        <JanelaConfirmar
          key={fila.length + atual.opcoes.titulo}
          opcoes={atual.opcoes}
          aoResponder={ok => { atual.resolver(ok); encerrar() }}
        />
      )}
      {atual && atual.tipo === 'texto' && (
        <JanelaTexto
          key={fila.length + atual.opcoes.titulo}
          opcoes={atual.opcoes}
          aoResponder={texto => { atual.resolver(texto); encerrar() }}
        />
      )}
    </ConfirmarContext.Provider>
  )
}

/** Fora do provedor devolve `false` e avisa no console — nunca cai em `window.confirm`. */
export function useConfirmar(): (o: OpcoesConfirmar) => Promise<boolean> {
  const ctx = useContext(ConfirmarContext)
  return useCallback((opcoes: OpcoesConfirmar) => {
    if (!ctx) {
      console.warn('useConfirmar usado fora do ConfirmarProvider; a ação foi recusada por segurança.')
      return Promise.resolve(false)
    }
    return new Promise<boolean>(resolver => ctx.enfileirar({ tipo: 'confirmar', opcoes, resolver }))
  }, [ctx])
}

/** Fora do provedor devolve `null` e avisa no console. */
export function usePedirTexto(): (o: OpcoesPedirTexto) => Promise<string | null> {
  const ctx = useContext(ConfirmarContext)
  return useCallback((opcoes: OpcoesPedirTexto) => {
    if (!ctx) {
      console.warn('usePedirTexto usado fora do ConfirmarProvider; a ação foi recusada por segurança.')
      return Promise.resolve(null)
    }
    return new Promise<string | null>(resolver => ctx.enfileirar({ tipo: 'texto', opcoes, resolver }))
  }, [ctx])
}

function Casca({
  titulo,
  descricao,
  aoDesistir,
  children,
  rodape,
}: {
  titulo: string
  descricao?: ReactNode
  aoDesistir: () => void
  children?: ReactNode
  rodape: ReactNode
}) {
  useEffect(() => {
    function aoTecla(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); aoDesistir() }
    }
    window.addEventListener('keydown', aoTecla, true)
    return () => window.removeEventListener('keydown', aoTecla, true)
  }, [aoDesistir])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={aoDesistir}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-md p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-base text-[var(--text)]">{titulo}</h3>
        {descricao && <div className="text-sm text-[var(--text-muted)]">{descricao}</div>}
        {children}
        <div className="flex justify-end gap-2 pt-1">{rodape}</div>
      </div>
    </div>
  )
}

const BOTAO_BASE = 'min-h-11 text-sm px-4 py-2 rounded-lg font-semibold transition-colors disabled:opacity-40'

function JanelaConfirmar({ opcoes, aoResponder }: { opcoes: OpcoesConfirmar; aoResponder: (ok: boolean) => void }) {
  const desistirRef = useRef<HTMLButtonElement>(null)
  const confirmarRef = useRef<HTMLButtonElement>(null)
  const respondido = useRef(false)

  const responder = useCallback((ok: boolean) => {
    if (respondido.current) return
    respondido.current = true
    aoResponder(ok)
  }, [aoResponder])

  useEffect(() => {
    (opcoes.perigo ? desistirRef.current : confirmarRef.current)?.focus()
  }, [opcoes.perigo])

  return (
    <Casca
      titulo={opcoes.titulo}
      descricao={opcoes.descricao}
      aoDesistir={() => responder(false)}
      rodape={
        <>
          <button
            ref={desistirRef}
            type="button"
            aria-label={opcoes.cancelarRotulo ?? 'Voltar'}
            onClick={() => responder(false)}
            className={`${BOTAO_BASE} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border-light)]`}
          >
            {opcoes.cancelarRotulo ?? 'Voltar'}
          </button>
          <button
            ref={confirmarRef}
            type="button"
            aria-label={opcoes.confirmarRotulo}
            onClick={() => responder(true)}
            className={`${BOTAO_BASE} ${
              opcoes.perigo
                ? 'border border-red-500/40 bg-red-500/10 text-[var(--danger)] hover:bg-red-500/20'
                : 'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)]'
            }`}
          >
            {opcoes.confirmarRotulo}
          </button>
        </>
      }
    />
  )
}

function JanelaTexto({ opcoes, aoResponder }: { opcoes: OpcoesPedirTexto; aoResponder: (t: string | null) => void }) {
  const [texto, setTexto] = useState('')
  const campoRef = useRef<HTMLTextAreaElement>(null)
  const respondido = useRef(false)

  const responder = useCallback((valor: string | null) => {
    if (respondido.current) return
    respondido.current = true
    aoResponder(valor)
  }, [aoResponder])

  useEffect(() => { campoRef.current?.focus() }, [])

  const limpo = texto.trim()
  const podeConfirmar = !opcoes.obrigatorio || limpo.length > 0

  return (
    <Casca
      titulo={opcoes.titulo}
      descricao={opcoes.descricao}
      aoDesistir={() => responder(null)}
      rodape={
        <>
          <button
            type="button"
            aria-label="Voltar"
            onClick={() => responder(null)}
            className={`${BOTAO_BASE} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border-light)]`}
          >
            Voltar
          </button>
          <button
            type="button"
            aria-label={opcoes.confirmarRotulo}
            disabled={!podeConfirmar}
            onClick={() => responder(limpo)}
            className={`${BOTAO_BASE} ${
              opcoes.perigo
                ? 'border border-red-500/40 bg-red-500/10 text-[var(--danger)] hover:bg-red-500/20'
                : 'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)]'
            }`}
          >
            {opcoes.confirmarRotulo}
          </button>
        </>
      }
    >
      <label className="block text-xs text-[var(--text-muted)]">
        {opcoes.rotuloCampo}
        <textarea
          ref={campoRef}
          value={texto}
          onChange={e => setTexto(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (podeConfirmar) responder(limpo)
            }
          }}
          rows={3}
          className="mt-1 w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)] resize-none focus:outline-none focus:border-[var(--primary)]"
        />
      </label>
    </Casca>
  )
}
