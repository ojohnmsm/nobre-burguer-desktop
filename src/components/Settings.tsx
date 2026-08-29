import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound, Link2, MonitorDown, Play, Printer, Save, Volume2 } from 'lucide-react'
import type { DesktopConfig, DesktopConfigInput, PrinterInfo } from '../electron-api'
import { playMessageAlert, playOrderAlert } from '../notification-sound'

interface Props {
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
  autoStart: 'true',
}

/** Pedido de mentira só para conferir a saída da impressora. */
const PEDIDO_TESTE = {
  id: 'teste-0000-0000-0000-000000000000',
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

export function Settings({ onSaved }: Props) {
  const [config, setConfig] = useState<DesktopConfig>(EMPTY_CONFIG)
  const [desktopApiKey, setDesktopApiKey] = useState('')
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [novaUrl, setNovaUrl] = useState('')
  const [mostrarAvancado, setMostrarAvancado] = useState(false)

  useEffect(() => {
    window.api.getConfig().then(setConfig).catch(() => setError('Não foi possível ler as configurações'))
    window.api.getPrinters().then(setPrinters).catch(() => setPrinters([]))
  }, [])

  function update<K extends keyof DesktopConfig>(key: K, value: DesktopConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }))
  }

  async function recarregar() {
    const atual = await window.api.getConfig()
    setConfig(atual)
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

  async function removerLoja(id: string, nome: string) {
    const certeza = window.confirm(
      `Desligar ${nome || 'esta loja'} deste computador? Os pedidos dela param de aparecer aqui.`
    )
    if (!certeza) return

    await window.api.removeConnection(id)
    await recarregar()
    onSaved()
  }

  async function save() {
    setError('')
    const input: DesktopConfigInput = {
      printerName: config.printerName,
      printerWidth: config.printerWidth,
      autoPrint: config.autoPrint,
      autoPrintChannels: config.autoPrintChannels,
      autoStart: config.autoStart,
    }

    try {
      await window.api.saveConfig(input)
      setSaved(true)
      window.setTimeout(() => { setSaved(false); onSaved() }, 800)
    } catch (saveError) {
      setError(`Erro ao salvar: ${saveError instanceof Error ? saveError.message : String(saveError)}`)
    }
  }

  async function testarImpressao() {
    // Salva a largura escolhida antes, senão o teste sai com a anterior.
    await window.api.saveConfig({ printerName: config.printerName, printerWidth: config.printerWidth })
    const resultado = await window.api.printOrder(PEDIDO_TESTE as never)
    if (resultado === 'no-printer') setError('Selecione uma impressora primeiro.')
    else if (resultado === 'error') setError('Não foi possível imprimir o teste.')
    else setError('')
  }

  const toggle = (key: 'autoPrint' | 'autoStart', label: string, description: string) => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-[var(--text)] font-medium">{label}</p>
        <p className="text-xs text-[var(--text-muted)]">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => update(key, config[key] === 'true' ? 'false' : 'true')}
        aria-pressed={config[key] === 'true'}
        className={`relative w-11 h-6 rounded-full transition-colors ${config[key] === 'true' ? 'bg-[var(--success)]' : 'bg-[var(--text-xmuted)]'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${config[key] === 'true' ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )

  return (
    <div className="p-6 max-w-lg mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold">Configurações</h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">Conecte este computador ao servidor sem expor a chave administrativa do banco.</p>
      </div>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Link2 size={15} className="text-[var(--primary)]" /> Lojas neste computador
        </div>

        {config.connections.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            Nenhuma loja ligada ainda. Adicione a primeira abaixo.
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
              onClick={() => removerLoja(conexao.id, conexao.label)}
              className="text-[var(--danger)] hover:bg-red-500/10 rounded-lg px-2 py-1.5 text-xs"
            >
              Remover
            </button>
          </div>
        ))}

        <div className="border-t border-[var(--border)] pt-3 space-y-2">
          <p className="text-xs text-[var(--text-muted)] font-medium">Ligar outra loja</p>

          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              placeholder="Código gerado no painel da loja"
              value={desktopApiKey}
              onChange={event => setDesktopApiKey(event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)] pr-10"
            />
            <button
              type="button"
              onClick={() => setShowToken(current => !current)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text)]"
              aria-label={showToken ? 'Ocultar código' : 'Mostrar código'}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          {/* O endereço fica escondido porque o código já diz qual servidor
              procurar. Só quem roda em instalação própria precisa dele, e essa
              pessoa sabe que precisa. */}
          <button
            type="button"
            onClick={() => setMostrarAvancado(v => !v)}
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline"
          >
            {mostrarAvancado ? 'Esconder' : 'Uso meu próprio servidor'}
          </button>

          {mostrarAvancado && (
            <input
              type="url"
              placeholder="https://www.cardapia.shop"
              value={novaUrl}
              onChange={event => setNovaUrl(event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
          )}

          <button
            type="button"
            onClick={adicionarLoja}
            disabled={!desktopApiKey.trim()}
            className="w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--primary-fg)] font-semibold rounded-xl py-2.5 text-sm transition-colors"
          >
            Ligar loja
          </button>

          <p className="text-[11px] text-[var(--text-xmuted)] flex gap-1.5">
            <KeyRound size={12} className="mt-px flex-shrink-0" />
            Cole o código gerado em Integrações, no painel da loja. Duas lojas no
            mesmo computador recebem pedidos lado a lado.
          </p>
        </div>
      </section>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Printer size={15} className="text-[var(--primary)]" /> Impressora térmica
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="printer-name">Impressora (58 mm)</label>
          {printers.length > 0 ? (
            <select
              id="printer-name"
              value={config.printerName}
              onChange={event => update('printerName', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="">— Selecionar impressora —</option>
              {printers.map(printer => <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>)}
            </select>
          ) : (
            <input
              id="printer-name"
              placeholder="Nome da impressora (ex.: POS-58)"
              value={config.printerName}
              onChange={event => update('printerName', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
          )}
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="printer-width">Largura do papel</label>
          <select
            id="printer-width"
            value={config.printerWidth}
            onChange={event => update('printerWidth', event.target.value)}
            className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
          >
            <option value="58">58 mm (32 colunas) — padrão</option>
            <option value="80">80 mm (48 colunas)</option>
          </select>
        </div>
        {toggle('autoPrint', 'Impressão automática', 'Imprime a comanda quando o polling encontrar um novo pedido.')}
        {config.autoPrint === 'true' && (
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1 font-medium" htmlFor="autoprint-channels">Imprimir automaticamente</label>
            <select
              id="autoprint-channels"
              value={config.autoPrintChannels}
              onChange={event => update('autoPrintChannels', event.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-4 py-2.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              <option value="all">Todos os pedidos</option>
              <option value="own">Só do site / WhatsApp</option>
              <option value="ifood">Só do iFood</option>
            </select>
            <p className="text-[11px] text-[var(--text-xmuted)] mt-1">
              Use &quot;Só do site / WhatsApp&quot; se o Gestor de Pedidos do iFood já imprime as comandas dele.
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={testarImpressao}
          disabled={!config.printerName}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors disabled:opacity-40"
        >
          <Printer size={12} /> Testar impressão
        </button>
      </section>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <Volume2 size={15} className="text-[var(--primary)]" /> Som de notificação
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Centralizado — configure no admin web (botão &quot;Som&quot; em Pedidos), vale pra todos os dispositivos.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => playOrderAlert()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors"
          >
            <Play size={12} /> Testar som de pedido
          </button>
          <button
            type="button"
            onClick={() => playMessageAlert()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors"
          >
            <Play size={12} /> Testar som de mensagem
          </button>
        </div>
      </section>

      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 space-y-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)] mb-1">
          <MonitorDown size={15} className="text-[var(--primary)]" /> Sistema
        </div>
        {toggle('autoStart', 'Iniciar com o Windows', 'Abre automaticamente ao ligar o computador.')}
      </section>

      {error && <p className="text-[var(--danger)] text-xs bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}

      <button
        onClick={save}
        className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${saved ? 'bg-[var(--success)] text-white' : 'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--primary-fg)]'}`}
      >
        <Save size={16} /> {saved ? 'Salvo!' : 'Salvar configurações'}
      </button>
    </div>
  )
}
