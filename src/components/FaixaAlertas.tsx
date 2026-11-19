import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { FalhaImpressao, SaudeApp } from '../electron-api'

/**
 * Faixas FIXAS acima do conteúdo, em todas as abas: só somem quando o problema
 * se resolve (ou, nos casos que dependem de a pessoa ter agido fora do app,
 * quando ela dispensa). Existem porque o aviso em pílula some em segundos, e a
 * cozinha não pode descobrir uma comanda que não saiu só pelo pedido reclamado.
 */

interface Props {
  saude: SaudeApp | null
  falhas: FalhaImpressao[]
  /** Reimprime o pedido; devolve a mensagem de erro, ou null se saiu. */
  onReimprimir: (orderId: string) => Promise<string | null>
  onDispensarFalha: (orderId: string) => void
  onAbrirConfiguracoes: () => void
  audioBloqueado: boolean
  onLiberarAudio: () => void
}

function hora(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function Linha({ children, acoes }: { children: React.ReactNode; acoes?: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-xs">
      <span className="flex items-start gap-1.5 text-[var(--danger)] font-bold min-w-0">
        <AlertTriangle size={13} className="flex-shrink-0 mt-px" aria-hidden="true" />
        <span className="min-w-0">{children}</span>
      </span>
      {acoes && <div className="flex items-center gap-2 flex-shrink-0">{acoes}</div>}
    </div>
  )
}

const BOTAO_PRIMARIO = 'text-[11px] px-2.5 py-1 rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] font-bold disabled:opacity-50'
const BOTAO_SECUNDARIO = 'text-[11px] px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] font-semibold hover:text-[var(--text)]'

function LinhaFalha({ falha, onReimprimir, onDispensar }: { falha: FalhaImpressao; onReimprimir: Props['onReimprimir']; onDispensar: () => void }) {
  const [enviando, setEnviando] = useState(false)
  return (
    <Linha
      acoes={
        <>
          <button
            type="button"
            disabled={enviando}
            onClick={() => {
              setEnviando(true)
              void onReimprimir(falha.orderId).finally(() => setEnviando(false))
            }}
            className={BOTAO_PRIMARIO}
          >
            {enviando ? 'Imprimindo...' : 'Imprimir de novo'}
          </button>
          <button type="button" onClick={onDispensar} className={BOTAO_SECUNDARIO}>Já resolvi</button>
        </>
      }
    >
      A comanda do pedido {falha.rotulo} não saiu · {falha.motivo}
    </Linha>
  )
}

export function FaixaAlertas({ saude, falhas, onReimprimir, onDispensarFalha, onAbrirConfiguracoes, audioBloqueado, onLiberarAudio }: Props) {
  const [relogioDispensadoMin, setRelogioDispensadoMin] = useState<number | null>(null)

  const conexoes = saude?.conexoes ?? []
  const varias = conexoes.length > 1
  const semConexao = conexoes.filter(c => c.estado === 'sem_rede' || c.estado === 'erro_servidor')
  const desligadas = conexoes.filter(c => c.estado === 'nao_autorizado')

  const diferenca = saude?.diferencaRelogioMs ?? 0
  const relogioMin = Math.round(Math.abs(diferenca) / 60000)
  const relogioErrado = Math.abs(diferenca) > 2 * 60000 && relogioMin !== relogioDispensadoMin

  // Sem loja ligada ainda não há comanda para sair: o aviso só confundiria a primeira tela.
  const semImpressora = saude?.autoPrintSemImpressora === true && saude.conexoes.length > 0
  const nada = falhas.length === 0 && !semImpressora && semConexao.length === 0
    && desligadas.length === 0 && !relogioErrado && !audioBloqueado
  if (nada) return null

  return (
    <div className="flex-shrink-0">
      {falhas.map(falha => (
        <LinhaFalha key={falha.orderId} falha={falha} onReimprimir={onReimprimir} onDispensar={() => onDispensarFalha(falha.orderId)} />
      ))}

      {semImpressora && (
        <Linha acoes={<button type="button" onClick={onAbrirConfiguracoes} className={BOTAO_PRIMARIO}>Escolher impressora</button>}>
          Nenhuma impressora escolhida · as comandas não estão saindo
        </Linha>
      )}

      {desligadas.map(c => (
        <Linha key={`off-${c.connectionId}`} acoes={<button type="button" onClick={onAbrirConfiguracoes} className={BOTAO_PRIMARIO}>Abrir configurações</button>}>
          Este aparelho foi desligado da loja {c.label || 'sem nome'} no painel · ligue a loja de novo em Configurações
        </Linha>
      ))}

      {semConexao.map(c => (
        <Linha key={`net-${c.connectionId}`}>
          {varias && c.label ? `${c.label}: sem` : 'Sem'} conexão com o servidor{c.ultimoSucessoEm ? ` desde ${hora(c.ultimoSucessoEm)}` : ''} · os pedidos na tela podem estar desatualizados
        </Linha>
      ))}

      {relogioErrado && (
        <Linha acoes={<button type="button" onClick={() => setRelogioDispensadoMin(relogioMin)} className={BOTAO_SECUNDARIO}>Entendi</button>}>
          O relógio deste aparelho está {relogioMin} min errado · os tempos de atraso foram corrigidos pela hora do servidor
        </Linha>
      )}

      {audioBloqueado && (
        <Linha acoes={<button type="button" onClick={onLiberarAudio} className={BOTAO_PRIMARIO}>Ligar o som</button>}>
          O som está bloqueado neste aparelho · os alertas de pedido não vão tocar até você tocar na tela
        </Linha>
      )}
    </div>
  )
}
