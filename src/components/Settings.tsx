import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, KeyRound, Link2, MonitorDown, Play, Printer, Volume2 } from 'lucide-react'
import type { DesktopConfig, DesktopConfigInput, PrinterInfo } from '../electron-api'
import { playMessageAlert, playOrderAlert } from '../notification-sound'
import { useConfirmar } from './Confirmar'
import { SaudeDoBalcaoAndroid } from './SaudeDoBalcaoAndroid'

interface Props {
  /** Chamado quando as lojas ligadas mudam (parear, remover). Mudar uma opção não chama. */
  onSaved: () => void
}

const EMPTY_CONFIG: DesktopConfig = {
  connections: [],
  apiBaseUrl: '',
  desktopApiKeyConfigured: false,
  printerName: '',
  printerWidth: '58',
  autoPrint: 'true',
  autoPrintChannels: 'all',
  printCopies: '1',
  scannerReady: 'false',
  autoStart: 'true',
}

/** Pedido de mentira só para conferir a saída da impressora. */
const PEDIDO_TESTE = {
  // O scanner reconhece PEDIDOTESTE como diagnóstico, sem chamar a API nem
  // alterar pedido real.
  id: 'TESTE',
  channel: 'web',
  order_number: 1,
  stores: { store_number: 1 },
  created_at: new Date().toISOString(),
  customer_name: 'Cliente Teste',
  customer_phone: '(11) 99999-9999',
  fulfillment_type: 'delivery',
  address: 'Rua de Teste', address_number: '123', address_complement: 'ap. 1',
  neighborhood: 'Centro', city: 'Cidade', state: 'SP',
  subtotal_cents: 3500, delivery_fee_cents: 500, total_cents: 4000,
  payment_method: 'pix', change_for_cents: null, notes: 'Teste de impressão',
  order_items: [
    { id: '1', product_name: 'X-Salada', quantity: 1, subtotal_cents: 2500, notes: 'sem cebola', addon_selections: [{ groupName: 'Extras', selectedOptions: [{ name: 'Bacon', price_cents: 500 }] }] },
    { id: '2', product_name: 'Refrigerante', quantity: 1, subtotal_cents: 1000, notes: null, addon_selections: [] },
  ],
}

type MotivoSemImpressoras = 'permissao' | 'bluetooth' | 'outro'

/** O agente do Android rejeita com `SEM_PERMISSAO` ou `BLUETOOTH_DESLIGADO` na mensagem ou no código. */
function motivoDaFalha(erro: unknown): MotivoSemImpressoras {
  const e = erro as { message?: unknown; code?: unknown } | null
  const texto = `${String(e?.message ?? erro ?? '')} ${String(e?.code ?? '')}`.toUpperCase()
  if (texto.includes('SEM_PERMISSAO')) return 'permissao'
  if (texto.includes('BLUETOOTH_DESLIGADO')) return 'bluetooth'
  return 'outro'
}

function abrirAjustesDoApp() {
  const ponte = (window as unknown as { cardapiaAndroid?: { abrirAjustesDoApp?: () => void } }).cardapiaAndroid
  ponte?.abrirAjustesDoApp?.()
}

/** O navegador só toca áudio depois de um toque; esta checagem diz se o contexto de áudio destravou. */
async function audioDestravado(): Promise<boolean> {
  try {
    const Classe = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Classe) return false
    const ctx = new Classe()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
    const ok = ctx.state === 'running'
    void ctx.close().catch(() => undefined)
    return ok
  } catch {
    return false
  }
}

export function Settings({ onSaved }: Props) {
  const confirmar = useConfirmar()
  const [config, setConfig] = useState<DesktopConfig>(EMPTY_CONFIG)
  const [desktopApiKey, setDesktopApiKey] = useState('')
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [impressorasCarregadas, setImpressorasCarregadas] = useState(false)
  const [motivoSemImpressoras, setMotivoSemImpressoras] = useState<MotivoSemImpressoras | null>(null)
  const [salvo, setSalvo] = useState(false)
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [novaUrl, setNovaUrl] = useState('')
  const [mostrarAvancado, setMostrarAvancado] = useState(false)
  const [codigo, setCodigo] = useState('')
  const [pareando, setPareando] = useState(false)
  // O campo do código LONGO some por padrão. Ele existe para quem já tinha o
  // token antigo anotado; o caminho normal agora é o de 8 caracteres.
  const [mostrarCodigoLongo, setMostrarCodigoLongo] = useState(false)
  const temporizadorSalvo = useRef<number | null>(null)

  // O app Android reaproveita esta tela; lá não existe "iniciar com o Windows"
  // e a impressora vem da lista de aparelhos Bluetooth pareados.
  const naoEhDesktop = window.api.plataforma === 'android'
  const aparelho = naoEhDesktop ? 'este tablet' : 'este computador'

  useEffect(() => {
    window.api.getConfig().then(setConfig).catch(() => setError('Não deu para ler as configurações · o aplicativo não respondeu'))
    carregarImpressoras()
    return () => { if (temporizadorSalvo.current) window.clearTimeout(temporizadorSalvo.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function carregarImpressoras() {
    window.api.getPrinters()
      .then(lista => { setPrinters(lista); setMotivoSemImpressoras(null) })
      .catch(erro => { setPrinters([]); setMotivoSemImpressoras(motivoDaFalha(erro)) })
      .finally(() => setImpressorasCarregadas(true))
  }

  function update<K extends keyof DesktopConfig>(key: K, value: DesktopConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }))
  }

  async function recarregar() {
    const atual = await window.api.getConfig()
    setConfig(atual)
  }

  /**
   * Grava SÓ o campo que mudou. Mandar a tela inteira regravava `autoPrint` com
   * o valor que esta tela leu ao abrir, desfazendo o que a barra de cima tinha
   * trocado nesse meio-tempo. Depois de gravar, relê a configuração do app.
   */
  async function salvarCampo(parcial: DesktopConfigInput) {
    setError('')
    try {
      await window.api.saveConfig(parcial)
      await recarregar()
      setSalvo(true)
      if (temporizadorSalvo.current) window.clearTimeout(temporizadorSalvo.current)
      temporizadorSalvo.current = window.setTimeout(() => setSalvo(false), 2000)
    } catch (falha) {
      setError(`Não deu para salvar · ${falha instanceof Error ? falha.message : 'o aplicativo não respondeu'}`)
      try { await recarregar() } catch { /* mantém a tela como está */ }
    }
  }

  function mudarCampo<K extends keyof DesktopConfigInput & keyof DesktopConfig>(key: K, value: string) {
    update(key, value as DesktopConfig[K])
    void salvarCampo({ [key]: value } as DesktopConfigInput)
  }

  async function adicionarLoja() {
    setError('')
    const resultado = await window.api.addConnection(novaUrl, desktopApiKey)
    if (resultado.erro) { setError(resultado.erro); return }

    setNovaUrl('')
    setDesktopApiKey('')
    await recarregar()
    // Avisa a tela principal: ela precisa buscar os pedidos da loja nova e
    // perguntar o nome dela ao servidor.
    onSaved()
  }

  /** Caminho normal: 8 caracteres digitados aqui viram o token no cofre. */
  async function parearAparelho() {
    setError('')
    setPareando(true)
    try {
      const resultado = await window.api.pairDevice(novaUrl, codigo)
      if (resultado.erro) { setError(resultado.erro); return }

      setNovaUrl('')
      setCodigo('')
      await recarregar()
      onSaved()
    } finally {
      setPareando(false)
    }
  }

  async function removerLoja(id: string, nome: string) {
    const certeza = await confirmar({
      titulo: `Desligar ${nome || 'esta loja'} deste aparelho?`,
      descricao: `Os pedidos dela param de aparecer ${naoEhDesktop ? 'neste tablet' : 'neste computador'}. Para voltar, será preciso um código novo do painel.`,
      confirmarRotulo: 'Desligar loja',
      cancelarRotulo: 'Manter loja',
      perigo: true,
    })
    if (!certeza) return

    await window.api.removeConnection(id)
    await recarregar()
    onSaved()
  }

  async function testarImpressao() {
    setError('')
    setAviso('')
    // A impressora e a largura já foram gravadas quando a pessoa as escolheu.
    try {
      const resultado = await window.api.printOrder(PEDIDO_TESTE as never, config.scannerReady === 'true')
      if (resultado.ok) setAviso('Teste enviado à impressora')
      else setError(`Não deu para imprimir o teste · ${resultado.error || 'a impressora não confirmou'}`)
    } catch {
      setError('Não deu para imprimir o teste · o aplicativo não respondeu')
    }
  }

  async function testarSom(tocar: () => void) {
    setError('')
    setAviso('')
    const destravado = await audioDestravado()
    tocar()
    if (destravado) setAviso('Som tocando. Se você não ouviu, aumente o volume do aparelho.')
    else setError(`O áudio está bloqueado ${naoEhDesktop ? 'neste tablet' : 'neste computador'} · toque em qualquer parte da tela e teste de novo. Se continuar mudo, confira o volume e o modo silencioso.`)
  }

  const toggle = (key: 'autoPrint' | 'scannerReady' | 'autoStart', label: string, description: string) => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-[var(--text)] font-medium">{label}</p>
        <p className="text-xs text-[var(--text-muted)]">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={config[key] === 'true'}
        aria-label={label}
        onClick={() => mudarCampo(key, config[key] === 'true' ? 'false' : 'true')}
        className={`relative w-12 h-7 flex-shrink-0 rounded-full transition-colors ${config[key] === 'true' ? 'bg-[var(--success)]' : 'bg-[var(--text-xmuted)]'}`}
      >
        <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${config[key] === 'true' ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )

  const larguraMm = config.printerWidth === '80' ? '80' : '58'

  return (
    <div className="p-6 max-w-lg mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Configurações</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            As mudanças valem na hora, não precisa salvar.
          </p>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={`text-xs text-[var(--success)] pt-1.5 transition-opacity ${salvo ? 'opacity-100' : 'opacity-0'}`}
        >
          Salvo
        </span>
      </div>

      {naoEhDesktop && <SaudeDoBalcaoAndroid />}

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Link2 size={15} className="text-[var(--primary)]" /> Lojas {naoEhDesktop ? 'neste tablet' : 'neste computador'}
        </div>

        {config.connections.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            Nenhuma loja ligada. Digite abaixo o código do painel para os pedidos aparecerem aqui.
          </p>
        )}

        {config.connections.map(conexao => (
          <div
            key={conexao.id}
            className="flex items-center gap-3 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2.5"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[var(--text)] truncate">{conexao.label || 'Loja sem nome'}</p>
              <p className="text-[11px] text-[var(--text-xmuted)] truncate">{conexao.apiBaseUrl}</p>
            </div>
            <button
              type="button"
              onClick={() => void removerLoja(conexao.id, conexao.label)}
              aria-label={`Desligar ${conexao.label || 'loja'} deste aparelho`}
              className="min-h-10 text-[var(--danger)] hover:bg-red-500/10 rounded-lg px-3 py-2 text-xs"
            >
              Desligar
            </button>
          </div>
        ))}

        <div className="border-t border-[var(--border)] pt-3 space-y-2">
          <p className="text-xs text-[var(--text-muted)] font-medium">
            {config.connections.length === 0 ? 'Ligar loja' : 'Ligar outra loja'}
          </p>

          {/* 8 caracteres, grandes e espaçados: este campo é preenchido por
              alguém lendo do celular e digitando aqui. O token real tem 47 e
              nunca passa por esta tela — chega do servidor e vai pro cofre. */}
          <input
            inputMode="text"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-label="Código de 8 caracteres do painel"
            value={codigo.length > 4 ? `${codigo.slice(0, 4)}-${codigo.slice(4)}` : codigo}
            onChange={event =>
              setCodigo(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8))
            }
            onKeyDown={event => {
              if (event.key === 'Enter' && codigo.length === 8 && !pareando) void parearAparelho()
            }}
            className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-3 text-center font-mono text-xl tracking-[0.25em] text-[var(--text)] placeholder:text-[var(--text-xmuted)] placeholder:tracking-[0.15em] focus:outline-none focus:border-[var(--primary)]"
          />

          <button
            type="button"
            onClick={parearAparelho}
            disabled={codigo.length !== 8 || pareando}
            aria-label="Ligar loja com o código"
            className="w-full min-h-11 bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--primary-fg)] font-semibold rounded-xl py-2.5 text-sm transition-colors"
          >
            {pareando ? 'Ligando…' : 'Ligar loja'}
          </button>

          <p className="text-[11px] text-[var(--text-muted)] flex gap-1.5">
            <KeyRound size={12} className="mt-px flex-shrink-0" />
            No painel da loja, em Integrações, toque em &quot;Ligar um aparelho&quot; e digite
            aqui o código de 8 caracteres. Duas lojas {naoEhDesktop ? 'no mesmo tablet' : 'no mesmo computador'} recebem
            pedidos lado a lado.
          </p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            {/* O endereço fica escondido porque o código já diz qual servidor
                procurar. Só quem roda em instalação própria precisa dele, e essa
                pessoa sabe que precisa. */}
            <button
              type="button"
              onClick={() => setMostrarAvancado(v => !v)}
              className="min-h-9 text-xs text-[var(--text-muted)] hover:text-[var(--text)] underline"
            >
              {mostrarAvancado ? 'Esconder endereço do servidor' : 'Uso meu próprio servidor'}
            </button>
            <button
              type="button"
              onClick={() => setMostrarCodigoLongo(v => !v)}
              className="min-h-9 text-xs text-[var(--text-muted)] hover:text-[var(--text)] underline"
            >
              {mostrarCodigoLongo ? 'Esconder código longo' : 'Tenho um código longo'}
            </button>
          </div>

          {mostrarAvancado && (
            <input
              type="url"
              placeholder="https://www.cardapia.shop"
              aria-label="Endereço do servidor"
              value={novaUrl}
              onChange={event => setNovaUrl(event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
          )}

          {mostrarCodigoLongo && (
            <div className="space-y-2 rounded-xl border border-[var(--border)] p-3">
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Código longo (cpd_…)"
                  aria-label="Código longo"
                  value={desktopApiKey}
                  onChange={event => setDesktopApiKey(event.target.value)}
                  className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)] pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(current => !current)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-2.5 text-[var(--text-muted)] hover:text-[var(--text)]"
                  aria-label={showToken ? 'Ocultar código' : 'Mostrar código'}
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                type="button"
                onClick={adicionarLoja}
                disabled={!desktopApiKey.trim()}
                aria-label="Ligar loja com o código longo"
                className="w-full min-h-11 bg-[var(--card)] hover:bg-[var(--border)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--text)] font-semibold rounded-xl py-2 text-sm transition-colors border border-[var(--border)]"
              >
                Ligar com código longo
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Printer size={15} className="text-[var(--primary)]" /> Impressora térmica
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="printer-name">Impressora ({larguraMm} mm)</label>
          {printers.length > 0 ? (
            <select
              id="printer-name"
              value={config.printerName}
              onChange={event => mudarCampo('printerName', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="">— Selecionar impressora —</option>
              {printers.map(printer => <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>)}
            </select>
          ) : naoEhDesktop ? (
            // No tablet a impressora é a pareada por Bluetooth; digitar um nome
            // aqui não levaria a lugar nenhum.
            <div className="space-y-2">
              {!impressorasCarregadas ? (
                <p className="text-xs text-[var(--text-muted)] bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5">
                  Procurando impressoras pareadas…
                </p>
              ) : motivoSemImpressoras === 'permissao' ? (
                <p className="text-xs text-[var(--danger)] bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
                  Não deu para listar as impressoras · o app não tem permissão de Bluetooth. Libere nos ajustes do app e volte aqui.
                </p>
              ) : motivoSemImpressoras === 'bluetooth' ? (
                <p className="text-xs text-[var(--danger)] bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
                  Não deu para listar as impressoras · o Bluetooth do tablet está desligado. Ligue e toque em Atualizar.
                </p>
              ) : motivoSemImpressoras === 'outro' ? (
                <p className="text-xs text-[var(--danger)] bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
                  Não deu para listar as impressoras · o Android não respondeu. Toque em Atualizar.
                </p>
              ) : (
                <p className="text-xs text-[var(--text-muted)] bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5">
                  Nenhuma impressora pareada. Ligue a impressora, pareie nas configurações de Bluetooth do Android e toque em Atualizar.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {motivoSemImpressoras === 'permissao' && (
                  <button
                    type="button"
                    onClick={abrirAjustesDoApp}
                    aria-label="Abrir ajustes do app"
                    className="min-h-11 text-sm px-4 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] font-semibold"
                  >
                    Abrir ajustes do app
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setImpressorasCarregadas(false); carregarImpressoras() }}
                  aria-label="Atualizar lista de impressoras"
                  className="min-h-11 text-sm px-4 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors"
                >
                  Atualizar
                </button>
              </div>
            </div>
          ) : (
            <input
              id="printer-name"
              placeholder="Nome da impressora (ex.: POS-58)"
              value={config.printerName}
              onChange={event => update('printerName', event.target.value)}
              onBlur={event => void salvarCampo({ printerName: event.target.value })}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
          )}
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="printer-width">Largura do papel</label>
          <select
            id="printer-width"
            value={config.printerWidth}
            onChange={event => mudarCampo('printerWidth', event.target.value)}
            className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
          >
            <option value="58">58 mm (32 colunas) — padrão</option>
            <option value="80">80 mm (48 colunas)</option>
          </select>
        </div>
        {toggle('autoPrint', 'Impressão automática', 'Imprime a comanda assim que um pedido novo chega.')}
        {toggle(
          'scannerReady',
          'Marcar pedido como pronto pelo QR',
          naoEhDesktop
            ? 'Imprime o QR na comanda e ativa a leitura do QR neste tablet.'
            : 'Imprime o QR na comanda e ativa a leitura pelo leitor de código ligado neste computador.'
        )}
        {config.autoPrint === 'true' && (
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="autoprint-channels">Imprimir automaticamente</label>
            <select
              id="autoprint-channels"
              value={config.autoPrintChannels}
              onChange={event => mudarCampo('autoPrintChannels', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="all">Todos os pedidos</option>
              <option value="own">Só do Cardápio próprio (Site, WhatsApp e Balcão)</option>
              <option value="ifood">Só de marketplace (iFood e 99Food)</option>
            </select>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              Escolha &quot;Só do Cardápio próprio&quot; se o app do marketplace (iFood, 99Food) já imprime as comandas dele.
            </p>
          </div>
        )}
        {config.autoPrint === 'true' && (
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="print-copies">Vias por pedido</label>
            <select
              id="print-copies"
              value={config.printCopies}
              onChange={event => mudarCampo('printCopies', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="1">1 via — padrão</option>
              <option value="2">2 vias (cozinha + sacola)</option>
              <option value="3">3 vias</option>
            </select>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              Vale só para a impressão automática. Reimprimir pelo cartão do pedido sai sempre com uma via.
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => void testarImpressao()}
          disabled={!config.printerName}
          aria-label={config.scannerReady === 'true' ? 'Testar impressão e QR' : 'Testar impressão'}
          className="flex items-center gap-1.5 min-h-11 text-sm px-4 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors disabled:opacity-40"
        >
          <Printer size={14} /> {config.scannerReady === 'true' ? 'Testar impressão e QR' : 'Testar impressão'}
        </button>
        <p className="text-[11px] text-[var(--text-muted)]">
          {config.scannerReady === 'true'
            ? (naoEhDesktop
                ? 'Depois de imprimir, leia o QR da comanda de teste. O app confirma na tela sem alterar nenhum pedido.'
                : 'Depois de imprimir, deixe o Cardapia em primeiro plano e leia o QR da comanda de teste. O aplicativo confirma na tela sem alterar nenhum pedido.')
            : 'Ative a opção acima para incluir e testar o QR da comanda.'}
        </p>
      </section>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Volume2 size={15} className="text-[var(--primary)]" /> Som de notificação
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {naoEhDesktop ? 'Este tablet usa' : 'Este computador usa'} o som que a loja escolheu no painel, em Pedidos, no botão &quot;Som&quot;. A escolha vale para todos os aparelhos.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => void testarSom(playOrderAlert)}
            aria-label="Testar som de pedido"
            className="flex items-center gap-1.5 min-h-11 text-sm px-4 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors"
          >
            <Play size={14} /> Testar som de pedido
          </button>
          <button
            type="button"
            onClick={() => void testarSom(playMessageAlert)}
            aria-label="Testar som de mensagem"
            className="flex items-center gap-1.5 min-h-11 text-sm px-4 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors"
          >
            <Play size={14} /> Testar som de mensagem
          </button>
        </div>
      </section>

      {!naoEhDesktop && (
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <MonitorDown size={15} className="text-[var(--primary)]" /> Sistema
        </div>
        {toggle('autoStart', 'Iniciar com o Windows', 'Abre o Cardapia sozinho quando o computador ligar.')}
      </section>
      )}

      {aviso && !error && <p role="status" className="text-[var(--text-muted)] text-xs bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2">{aviso}</p>}
      {error && <p role="alert" className="text-[var(--danger)] text-xs bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}
    </div>
  )
}
