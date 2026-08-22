import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound, Link2, MonitorDown, Play, Printer, Save, Volume2 } from 'lucide-react'
import type { DesktopConfig, DesktopConfigInput, PrinterInfo } from '../electron-api'
import { playMessageAlert, playOrderAlert } from '../notification-sound'

interface Props {
  onSaved: () => void
}

const EMPTY_CONFIG: DesktopConfig = {
  apiBaseUrl: '',
  desktopApiKeyConfigured: false,
  printerName: '',
  autoPrint: 'true',
  autoStart: 'true',
}

export function Settings({ onSaved }: Props) {
  const [config, setConfig] = useState<DesktopConfig>(EMPTY_CONFIG)
  const [desktopApiKey, setDesktopApiKey] = useState('')
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)

  useEffect(() => {
    window.api.getConfig().then(setConfig).catch(() => setError('Não foi possível ler as configurações'))
    window.api.getPrinters().then(setPrinters).catch(() => setPrinters([]))
  }, [])

  function update<K extends keyof DesktopConfig>(key: K, value: DesktopConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }))
  }

  async function save() {
    setError('')
    const input: DesktopConfigInput = {
      apiBaseUrl: config.apiBaseUrl,
      desktopApiKey: desktopApiKey || undefined,
      printerName: config.printerName,
      autoPrint: config.autoPrint,
      autoStart: config.autoStart,
    }

    try {
      await window.api.saveConfig(input)
      setConfig(current => ({ ...current, desktopApiKeyConfigured: current.desktopApiKeyConfigured || Boolean(desktopApiKey) }))
      setDesktopApiKey('')
      setSaved(true)
      window.setTimeout(() => { setSaved(false); onSaved() }, 800)
    } catch (saveError) {
      setError(`Erro ao salvar: ${saveError instanceof Error ? saveError.message : String(saveError)}`)
    }
  }

  const toggle = (key: 'autoPrint' | 'autoStart', label: string, description: string) => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-gray-300 font-medium">{label}</p>
        <p className="text-xs text-gray-600">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => update(key, config[key] === 'true' ? 'false' : 'true')}
        aria-pressed={config[key] === 'true'}
        className={`relative w-11 h-6 rounded-full transition-colors ${config[key] === 'true' ? 'bg-green-500' : 'bg-[#333]'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${config[key] === 'true' ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )

  return (
    <div className="p-6 max-w-lg mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold">Configurações</h2>
        <p className="text-sm text-gray-500 mt-1">Conecte este computador ao servidor sem expor a chave administrativa do banco.</p>
      </div>

      <section className="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-300 mb-1">
          <Link2 size={15} className="text-amber-400" /> Integração do servidor
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1 font-medium" htmlFor="api-base-url">URL do cardápio</label>
          <input
            id="api-base-url"
            type="url"
            placeholder="https://seu-dominio.com"
            value={config.apiBaseUrl}
            onChange={event => update('apiBaseUrl', event.target.value)}
            className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1 font-medium" htmlFor="desktop-token">Token de integração</label>
          <div className="relative">
            <input
              id="desktop-token"
              type={showToken ? 'text' : 'password'}
              placeholder={config.desktopApiKeyConfigured ? 'Token já configurado — informe outro para substituir' : 'Cole o token desta loja'}
              value={desktopApiKey}
              onChange={event => setDesktopApiKey(event.target.value)}
              className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowToken(current => !current)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="text-[11px] text-gray-600 mt-1 flex gap-1.5">
            <KeyRound size={12} className="mt-px flex-shrink-0" />
            Token desta loja, gerado no painel. Cada loja tem o seu — não é
            mais o token único do servidor.
          </p>
        </div>
      </section>

      <section className="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-300 mb-1">
          <Printer size={15} className="text-amber-400" /> Impressora térmica
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1 font-medium" htmlFor="printer-name">Impressora (58 mm)</label>
          {printers.length > 0 ? (
            <select
              id="printer-name"
              value={config.printerName}
              onChange={event => update('printerName', event.target.value)}
              className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-amber-500"
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
              className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500"
            />
          )}
        </div>
        {toggle('autoPrint', 'Impressão automática', 'Imprime a comanda quando o polling encontrar um novo pedido.')}
      </section>

      <section className="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-300 mb-1">
          <Volume2 size={15} className="text-amber-400" /> Som de notificação
        </div>
        <p className="text-xs text-gray-500">
          Centralizado — configure no admin web (botão &quot;Som&quot; em Pedidos), vale pra todos os dispositivos.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => playOrderAlert()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#333] hover:border-amber-500 hover:text-amber-400 text-gray-400 transition-colors"
          >
            <Play size={12} /> Testar som de pedido
          </button>
          <button
            type="button"
            onClick={() => playMessageAlert()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#333] hover:border-amber-500 hover:text-amber-400 text-gray-400 transition-colors"
          >
            <Play size={12} /> Testar som de mensagem
          </button>
        </div>
      </section>

      <section className="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-300 mb-1">
          <MonitorDown size={15} className="text-amber-400" /> Sistema
        </div>
        {toggle('autoStart', 'Iniciar com o Windows', 'Abre automaticamente ao ligar o computador.')}
      </section>

      {error && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}

      <button
        onClick={save}
        className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${saved ? 'bg-green-500 text-white' : 'bg-amber-500 hover:bg-amber-400 text-black'}`}
      >
        <Save size={16} /> {saved ? 'Salvo!' : 'Salvar configurações'}
      </button>
    </div>
  )
}
