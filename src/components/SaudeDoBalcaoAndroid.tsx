import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, CircleAlert, ShieldCheck } from 'lucide-react'
import type { SaudeDoBalcao } from '../android/global'

/**
 * "Saúde do balcão" — o que o tablet precisa para avisar pedido com o app no
 * fundo ou a tela apagada, cada item com o estado e o botão de corrigir.
 *
 * Só existe no app Android: sem `window.cardapiaAndroid` (Electron, navegador)
 * não renderiza nada, então é seguro importar em qualquer build.
 */
export function SaudeDoBalcaoAndroid() {
  const ponte = typeof window !== 'undefined' ? window.cardapiaAndroid : undefined
  const [saude, setSaude] = useState<SaudeDoBalcao | null>(null)

  const atualizar = useCallback(async () => {
    if (!ponte) return
    setSaude(await ponte.saudeDoBalcao())
  }, [ponte])

  useEffect(() => {
    if (!ponte) return
    void Promise.resolve().then(atualizar)
    // Quem corrige um item vai para os ajustes do Android e volta: relê ao voltar.
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') void atualizar()
    }
    document.addEventListener('visibilitychange', aoVoltar)
    const intervalo = window.setInterval(() => void atualizar(), 10_000)
    return () => {
      document.removeEventListener('visibilitychange', aoVoltar)
      window.clearInterval(intervalo)
    }
  }, [ponte, atualizar])

  if (!ponte || !saude) return null

  async function depois(acao: () => Promise<unknown>) {
    await acao()
    await atualizar()
  }

  const itens: { ok: boolean; titulo: string; okTexto: string; faltaTexto: string; botao?: { rotulo: string; acao: () => Promise<unknown> } }[] = [
    {
      ok: saude.notificacoes,
      titulo: 'Notificações',
      okTexto: 'Permitidas. O pedido novo toca mesmo com o app no fundo.',
      faltaTexto: 'Bloqueadas · sem elas, pedido com o app no fundo não toca.',
      botao: {
        rotulo: 'Permitir notificações',
        acao: async () => {
          const permitiu = await ponte.pedirPermissaoNotificacao()
          // Negada de vez, o Android não pergunta de novo: só pelos ajustes.
          if (!permitiu) await ponte.abrirAjustesDoApp()
        },
      },
    },
    {
      ok: saude.isentoBateria,
      titulo: 'Bateria sem restrição',
      okTexto: 'O Android não segura o Cardapia para economizar bateria.',
      faltaTexto: 'Restrita · o Android pode parar o Cardapia para economizar bateria.',
      botao: { rotulo: 'Liberar bateria', acao: () => ponte.pedirIsencaoBateria() },
    },
    {
      ok: saude.podeTelaCheia,
      titulo: 'Acender a tela',
      okTexto: 'Pedido novo acende a tela e abre a fila.',
      faltaTexto: 'Não permitido · com a tela apagada, o pedido só aparece como notificação.',
      botao: { rotulo: 'Abrir ajuste', acao: () => ponte.abrirAjusteTelaCheia() },
    },
    {
      ok: saude.vigiaRodando || !saude.lojaPareada,
      titulo: 'Recebendo pedidos',
      okTexto: saude.lojaPareada
        ? 'O tablet está de olho nos pedidos, mesmo com a tela apagada.'
        : 'Ligue uma loja abaixo para começar.',
      faltaTexto: saude.nativo
        ? 'Parado · pedido novo não avisa com o app no fundo.'
        : 'Esta versão só recebe pedido com o app aberto na tela.',
      botao: saude.nativo ? { rotulo: 'Ligar de novo', acao: () => ponte.reiniciarVigia() } : undefined,
    },
    {
      ok: saude.bluetoothPermitido && saude.bluetoothLigado,
      titulo: 'Bluetooth da impressora',
      okTexto: 'Permitido e ligado.',
      faltaTexto: !saude.bluetoothExiste
        ? 'Este tablet não tem Bluetooth.'
        : !saude.bluetoothPermitido
          ? 'Sem permissão · o Cardapia precisa de "dispositivos próximos" para imprimir.'
          : 'Desligado · ligue o Bluetooth nas configurações rápidas do tablet.',
      botao: saude.bluetoothExiste && !saude.bluetoothPermitido
        ? {
            rotulo: 'Permitir dispositivos próximos',
            acao: async () => {
              const permitiu = await ponte.pedirPermissaoBluetooth()
              if (!permitiu) await ponte.abrirAjustesDoApp()
            },
          }
        : undefined,
    },
  ]

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
        <ShieldCheck size={15} className="text-[var(--primary)]" /> Saúde do balcão
      </div>

      <ul className="space-y-2">
        {itens.map((item) => (
          <li
            key={item.titulo}
            className="flex items-center gap-3 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2.5"
          >
            {item.ok
              ? <CircleCheck size={18} className="text-[var(--success)] flex-shrink-0" aria-hidden />
              : <CircleAlert size={18} className="text-[var(--danger)] flex-shrink-0" aria-hidden />}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[var(--text)] font-medium">{item.titulo}</p>
              <p className="text-xs text-[var(--text-muted)]">{item.ok ? item.okTexto : item.faltaTexto}</p>
            </div>
            {!item.ok && item.botao && (
              <button
                type="button"
                onClick={() => void depois(item.botao!.acao)}
                className="text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors flex-shrink-0"
              >
                {item.botao.rotulo}
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-4 pt-1">
        <div>
          <p className="text-sm text-[var(--text)] font-medium">Manter a tela ligada</p>
          <p className="text-xs text-[var(--text-muted)]">A fila fica à vista o dia todo. Desligue só se o tablet não ficar na tomada.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={saude.telaLigada}
          aria-label="Manter a tela ligada"
          onClick={() => void depois(() => ponte.manterTelaLigada(!saude.telaLigada))}
          className={`relative w-12 h-7 flex-shrink-0 rounded-full transition-colors ${saude.telaLigada ? 'bg-[var(--success)]' : 'bg-[var(--text-xmuted)]'}`}
        >
          <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${saude.telaLigada ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="border-t border-[var(--border)] pt-3 space-y-1.5">
        <p className="text-xs text-[var(--text-muted)] font-medium">Dois ajustes que só dá para fazer no tablet</p>
        <ol className="text-[11px] text-[var(--text-xmuted)] list-decimal pl-4 space-y-1">
          <li>
            Configurações › Bateria › Limites de uso em segundo plano › Apps que nunca são suspensos › adicione o Cardapia.
            Sem isso, a Samsung pode parar o app mesmo com a bateria liberada aqui.
          </li>
          <li>
            Fixe o app: Configurações › Segurança e privacidade › Mais configurações de segurança › Fixar app. Depois, na
            tela de apps recentes, toque no ícone do Cardapia › Fixar este app. Assim o botão de início não tira a fila da tela.
          </li>
        </ol>
        <p className="text-[11px] text-[var(--text-xmuted)]">
          Deixe o tablet do balcão sem PIN nem padrão de bloqueio: é o jeito garantido de a tela acender sozinha no pedido
          novo já com a fila à vista.
        </p>
      </div>
    </section>
  )
}
