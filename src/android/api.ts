import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { orderLabel } from '../../electron/receiptFormat'
import type { DesktopConfigInput, EstadoConexao, FalhaImpressao, ResultadoImpressao, SaudeApp } from '../electron-api'
import { buildReceiptEscPos, paraBase64 } from './escpos'
import type { CardapiaAndroidApi, MotivoSemImpressoras, SaudeDoBalcao } from './global'

/**
 * `window.api` do app Android.
 *
 * No desktop, a interface conversa com o processo principal do Electron por IPC
 * (electron/preload.ts → electron/main.ts). No tablet não existe processo
 * principal: este arquivo faz o mesmo papel dentro da própria WebView, com HTTP
 * nativo do Capacitor (as rotas /api/desktop/* não respondem CORS, e nem
 * deveriam) e um plugin nativo pequeno para a impressora Bluetooth.
 *
 * A lógica é um porte de electron/main.ts e precisa continuar igual a ele:
 * várias lojas por aparelho, dedupe por id, "visto" por conexão, ETag. Ao mudar
 * uma regra lá, mude aqui.
 *
 * Quem decide o que é pedido NOVO é o vigia NATIVO (VigiaPedidosService, via
 * o plugin "Vigia"): com a página oculta o Chromium estrangula os timers da
 * WebView e o Android congela o processo do app em segundo plano, então um
 * vigia em JavaScript não avisa nada com o app no fundo ou a tela apagada. O
 * serviço em primeiro plano não para; ele toca a notificação quando o app está
 * fora da frente e manda os eventos para cá quando está na frente. A impressão
 * continua aqui (a comanda é montada em JS), por uma fila persistida no nativo.
 *
 * O vigia em JS mais abaixo é só o RECUO para quando o plugin não existe (ex.:
 * a interface aberta no navegador de preview).
 */

declare const __APP_VERSION__: string

// ── Plugin nativo da impressora ───────────────────────────────────────────
interface ImpressoraBluetoothPlugin {
  /** Rejeita com code SEM_PERMISSAO ou BLUETOOTH_DESLIGADO. */
  listarPareadas(): Promise<{ dispositivos: { nome: string; endereco: string }[] }>
  imprimir(opts: { endereco: string; dadosBase64: string }): Promise<void>
  estado(): Promise<{ existe: boolean; ligado: boolean; permitido: boolean }>
  pedirPermissao(): Promise<{ permitido: boolean }>
}

const ImpressoraBluetooth = registerPlugin<ImpressoraBluetoothPlugin>('ImpressoraBluetooth')

// ── Plugin nativo do vigia (android/.../VigiaPlugin.java) ─────────────────
interface ConexaoParaVigia { id: string; apiBaseUrl: string; apiKey: string; label: string }
interface PendenteImpressao { id: string; connectionId: string; em: number; pedido: Pedido }
interface EstadoVigia {
  rodando: boolean
  ativo: boolean
  lojaPareada: boolean
  ultimoCicloEm?: number
  pedidos?: Pedido[]
  saude?: SaudeApp
  notificacoes: boolean
  isentoBateria: boolean
  podeTelaCheia: boolean
  telaLigada: boolean
}

interface VigiaPluginApi {
  configurar(opts: {
    conexoes: ConexaoParaVigia[]
    autoPrint: boolean
    autoPrintChannels: string
    printCopies: number
    printerName: string
    scannerReady: boolean
  }): Promise<void>
  iniciar(): Promise<{ lojaPareada: boolean }>
  parar(): Promise<void>
  verificarAgora(): Promise<void>
  estado(): Promise<EstadoVigia>
  pedirPermissaoNotificacao(): Promise<{ permitido: boolean }>
  pedirIsencaoBateria(): Promise<{ isento: boolean }>
  podeTelaCheia(): Promise<{ pode: boolean }>
  abrirAjusteTelaCheia(): Promise<void>
  abrirAjustesDoApp(): Promise<void>
  manterTelaLigada(opts: { ligar: boolean }): Promise<void>
  pendentesDeImpressao(): Promise<{ pendentes: PendenteImpressao[] }>
  confirmarImpressos(opts: { ids: string[] }): Promise<void>
  addListener(evento: 'pedidosAtualizados', cb: (d: { pedidos: Pedido[] }) => void): Promise<PluginListenerHandle>
  addListener(evento: 'novoPedido', cb: (d: { info: NovoPedidoInfo; pedido: Pedido; imprimir: boolean }) => void): Promise<PluginListenerHandle>
  addListener(evento: 'saude', cb: (d: SaudeApp) => void): Promise<PluginListenerHandle>
}

const Vigia = registerPlugin<VigiaPluginApi>('Vigia')

/** Dentro do APK com o plugin registrado; fora disso (preview no navegador), recuo em JS. */
const usarVigiaNativo = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Vigia')

// ── Config persistida ─────────────────────────────────────────────────────
interface ConnectionRecord {
  id: string
  apiBaseUrl: string
  /**
   * Token da loja. Fica no armazenamento privado do app (SharedPreferences),
   * que outro aplicativo não lê num Android sem root.
   */
  apiKey: string
  label?: string
}

interface ConfigArmazenada {
  connections: ConnectionRecord[]
  /** Endereço MAC da impressora pareada. */
  printerName: string
  printerWidth: string
  autoPrint: string
  autoPrintChannels: string
  printCopies: string
  scannerReady: string
}

const CHAVE_CONFIG = 'cardapia-config'
const SERVIDOR_PADRAO = 'https://www.cardapia.shop'

let config: ConfigArmazenada = {
  connections: [],
  printerName: '',
  printerWidth: '58',
  autoPrint: 'true',
  autoPrintChannels: 'all',
  printCopies: '1',
  scannerReady: 'false',
}

async function carregarConfig() {
  try {
    const { value } = await Preferences.get({ key: CHAVE_CONFIG })
    if (value) config = { ...config, ...(JSON.parse(value) as Partial<ConfigArmazenada>) }
    if (!Array.isArray(config.connections)) config.connections = []
  } catch {
    // Config ilegível equivale a aparelho novo: a tela pede o pareamento.
  }
}

async function gravarConfig() {
  await Preferences.set({ key: CHAVE_CONFIG, value: JSON.stringify(config) })
  // Toda mudança de loja ou de regra de impressão vai também para o vigia
  // nativo, que guarda a própria cópia (token cifrado no Keystore).
  await sincronizarVigia()
}

async function sincronizarVigia() {
  if (!usarVigiaNativo) return
  try {
    await Vigia.configurar({
      conexoes: getConnections().map((c) => ({ id: c.id, apiBaseUrl: c.apiBaseUrl, apiKey: c.apiKey, label: c.label || '' })),
      autoPrint: config.autoPrint !== 'false',
      autoPrintChannels: config.autoPrintChannels || 'all',
      printCopies: Number(normalizarVias(config.printCopies)),
      printerName: config.printerName || '',
      scannerReady: config.scannerReady === 'true',
    })
  } catch (erro) {
    console.error('Não consegui configurar o vigia nativo:', erro)
  }
}

function urlValida(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Endereço novo de servidor: no tablet só https. O Android bloqueia http em
 * texto claro, e sem esta checagem a pessoa via só "não foi possível falar com
 * o servidor", sem saber por quê.
 */
function erroDeEndereco(url: string): string | null {
  let protocolo: string
  try {
    protocolo = new URL(url).protocol
  } catch {
    return 'Endereço inválido'
  }
  if (protocolo === 'http:') return 'Endereço recusado · o tablet só fala com servidor https://'
  if (protocolo !== 'https:') return 'Endereço inválido'
  return null
}

function getConnections(): ConnectionRecord[] {
  return config.connections.filter((c) => c.apiBaseUrl && c.apiKey && urlValida(c.apiBaseUrl))
}

function getConnection(connectionId?: string): ConnectionRecord | null {
  const todas = getConnections()
  if (!connectionId) return todas[0] ?? null
  return todas.find((c) => c.id === connectionId) ?? null
}

function normalizarVias(valor: string | undefined): string {
  const n = Number.parseInt(String(valor ?? '1'), 10)
  if (!Number.isFinite(n) || n < 1) return '1'
  return String(Math.min(n, 3))
}

// ── HTTP ──────────────────────────────────────────────────────────────────
interface Resposta {
  status: number
  ok: boolean
  data: unknown
  etag: string | null
  /** Header Date do servidor, em ms (para a diferença de relógio). */
  dataServidor: number | null
}

/** Resposta HTTP não-2xx: carrega o status para a saúde separar 401/403 de 5xx. */
class ErroHttp extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function http(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Resposta> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  const temCorpo = method !== 'GET'
  if (temCorpo) headers['Content-Type'] = 'application/json'

  const r = await CapacitorHttp.request({
    url,
    method,
    headers,
    // POST sem corpo vira `{}`: a conexão nativa do Android reclama de método
    // de escrita sem nada para escrever, e as rotas ignoram o corpo vazio.
    data: temCorpo ? opts.body ?? {} : undefined,
    connectTimeout: 15_000,
    readTimeout: 25_000,
  })

  let data: unknown = r.data
  if (typeof data === 'string') {
    try { data = data ? JSON.parse(data) : null } catch { data = null }
  }

  const cabecalho = (nome: string) => {
    const chave = Object.keys(r.headers ?? {}).find((k) => k.toLowerCase() === nome)
    return chave ? String(r.headers[chave]) : null
  }
  const dataBruta = cabecalho('date')
  const dataServidor = dataBruta ? Date.parse(dataBruta) : NaN
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    data,
    etag: cabecalho('etag'),
    dataServidor: Number.isFinite(dataServidor) ? dataServidor : null,
  }
}

function mensagemDeErro(resposta: Resposta): string {
  const d = resposta.data
  if (d && typeof d === 'object' && !Array.isArray(d) && 'error' in d) {
    return String((d as { error: unknown }).error)
  }
  return `Servidor respondeu ${resposta.status}`
}

async function desktopRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  connectionId?: string
): Promise<T> {
  const connection = getConnection(connectionId)
  if (!connection) throw new Error('Configure a URL e o código da loja')

  const resposta = await http(`${connection.apiBaseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${connection.apiKey}` },
  })
  if (!resposta.ok) throw new ErroHttp(mensagemDeErro(resposta), resposta.status)
  return resposta.data as T
}

/** Envelopa uma chamada no formato `{ ok, ... } | { ok: false, error }` que a interface espera. */
async function tentar<T extends object>(
  acao: () => Promise<T>,
  erroPadrao: string
): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await acao()) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : erroPadrao }
  }
}

// ── Eventos (o que no desktop chega por IPC) ──────────────────────────────
type Pedido = Record<string, unknown>
type NovoPedidoInfo = { id: string; label: string; canal: string; customerName: string; isPickup: boolean }

function emissor<T>() {
  const ouvintes = new Set<(valor: T) => void>()
  return {
    emitir: (valor: T) => { for (const cb of ouvintes) cb(valor) },
    assinar: (cb: (valor: T) => void) => {
      ouvintes.add(cb)
      return () => { ouvintes.delete(cb) }
    },
  }
}

const erroDeImpressao = emissor<string>()
const falhaDeImpressao = emissor<FalhaImpressao>()
const novoPedido = emissor<NovoPedidoInfo>()
const pedidosAtualizados = emissor<Pedido[]>()
const saude = emissor<SaudeApp>()
let ultimaSaude: SaudeApp | null = null

function definirSaude(s: SaudeApp) {
  ultimaSaude = s
  saude.emitir(s)
}

// ── Impressão ─────────────────────────────────────────────────────────────
let falhasImpressaoRecentes: number[] = []
let ultimaImpressaoFalhou = false
let filaImpressao: Promise<unknown> = Promise.resolve()

function falhasImpressaoNaUltimaHora(): number {
  const umaHoraAtras = Date.now() - 3600_000
  falhasImpressaoRecentes = falhasImpressaoRecentes.filter((ts) => ts > umaHoraAtras)
  return falhasImpressaoRecentes.length
}

function codigoDoErro(erro: unknown): string {
  return erro && typeof erro === 'object' && 'code' in erro ? String((erro as { code: unknown }).code) : ''
}

/** O motivo de "A comanda não saiu · motivo", a partir do código do plugin. */
function motivoDaFalha(codigo: string): string {
  if (codigo === 'SEM_PERMISSAO') return 'o Cardapia não tem a permissão de dispositivos próximos'
  if (codigo === 'BLUETOOTH_DESLIGADO') return 'o Bluetooth do tablet está desligado'
  if (codigo === 'ENVIO') return 'a conexão com a impressora caiu no meio do envio; confira se saiu papel'
  return 'impressora desligada ou fora de alcance'
}

function registrarSemImpressora(order: Pedido): ResultadoImpressao {
  const motivo = 'nenhuma impressora escolhida em Configurações'
  falhaDeImpressao.emitir({ orderId: String(order.id ?? ''), rotulo: orderLabel(order as never), motivo, viasQueFaltaram: 1 })
  return { ok: false, error: `A comanda não saiu · ${motivo}` }
}

/**
 * Imprime `vias` comandas. Nunca lança: avisa a tela pelo canal de erro (texto,
 * com o que a pessoa do balcão pode FAZER) e pelo onFalhaImpressao
 * (estruturado), e devolve o que aconteceu.
 *
 * Os códigos vêm do plugin nativo e separam "nada foi enviado" (pode tentar de
 * novo sem medo) de "caiu no meio do envio" — aí pode ter saído papel, e
 * repetir sozinho dobraria a comanda. Mesma regra do desktop.
 */
async function imprimir(order: Pedido, vias: number, includeReadyQr: boolean): Promise<ResultadoImpressao> {
  const endereco = config.printerName
  const widthCols = config.printerWidth === '80' ? 48 : 32
  const rotulo = orderLabel(order as never)
  const pedido = `#${rotulo}`
  const dadosBase64 = paraBase64(buildReceiptEscPos(order, widthCols, includeReadyQr))

  const trabalho = async (): Promise<ResultadoImpressao> => {
    for (let i = 0; i < vias; i += 1) {
      try {
        await ImpressoraBluetooth.imprimir({ endereco, dadosBase64 })
        ultimaImpressaoFalhou = false
      } catch (erro) {
        falhasImpressaoRecentes.push(Date.now())
        ultimaImpressaoFalhou = true
        const codigo = codigoDoErro(erro)
        console.error(`Falha ao imprimir o pedido ${pedido}:`, erro)

        if (codigo === 'SEM_PERMISSAO') {
          erroDeImpressao.emitir('O Cardapia precisa da permissão de dispositivos próximos para imprimir. Libere nas configurações do Android.')
        } else if (codigo === 'BLUETOOTH_DESLIGADO') {
          erroDeImpressao.emitir(`A comanda do pedido ${pedido} não saiu: o Bluetooth do tablet está desligado.`)
        } else if (codigo === 'ENVIO') {
          erroDeImpressao.emitir(`Confira se a comanda do pedido ${pedido} saiu. Se não saiu, use Imprimir no cartão.`)
        } else {
          erroDeImpressao.emitir(`A comanda do pedido ${pedido} não saiu: impressora desligada ou fora de alcance. Ligue a impressora, deixe perto do tablet e use Imprimir no cartão.`)
        }

        const motivo = motivoDaFalha(codigo)
        falhaDeImpressao.emitir({ orderId: String(order.id ?? ''), rotulo, motivo, viasQueFaltaram: vias - i })
        const abertura = codigo === 'ENVIO' ? 'A comanda pode não ter saído' : 'A comanda não saiu'
        return { ok: false, error: `${abertura} · ${motivo}` }
      }
    }
    return { ok: true }
  }

  // Uma comanda por vez: dois pedidos chegando juntos não podem disputar o
  // mesmo canal Bluetooth.
  const tarefa = filaImpressao.then(trabalho, trabalho)
  filaImpressao = tarefa.catch(() => {})
  return tarefa
}

async function reportarDiagnostico() {
  await Promise.allSettled(
    getConnections().map((conexao) =>
      desktopRequest(
        '/api/desktop/diagnostico',
        {
          method: 'POST',
          body: {
            appVersion: `${__APP_VERSION__}-android`,
            printPath: ultimaImpressaoFalhou ? 'falhou' : null,
            printFailures1h: falhasImpressaoNaUltimaHora(),
          },
        },
        conexao.id
      )
    )
  )
}

// ── Saúde no recuo em JS (no nativo, quem calcula é o serviço) ────────────
const estadosJs = new Map<string, { estado: EstadoConexao; ultimoSucessoEm: number | null }>()
let diferencaRelogioMs = 0

function anotarEstado(connId: string, estado: EstadoConexao) {
  const anterior = estadosJs.get(connId)
  estadosJs.set(connId, {
    estado,
    ultimoSucessoEm: estado === 'ok' ? Date.now() : anterior?.ultimoSucessoEm ?? null,
  })
}

function saudeDoRecuo(): SaudeApp {
  return {
    conexoes: getConnections().map((c) => ({
      connectionId: c.id,
      label: c.label || '',
      estado: estadosJs.get(c.id)?.estado ?? 'sem_rede',
      ultimoSucessoEm: estadosJs.get(c.id)?.ultimoSucessoEm ?? null,
    })),
    diferencaRelogioMs,
    autoPrintSemImpressora: config.autoPrint !== 'false' && !config.printerName,
  }
}

// ── Busca de pedidos (ETag + várias lojas) ────────────────────────────────
const cacheEtagPedidos = new Map<string, { etag: string; pedidos: Pedido[] }>()

async function buscarPedidosComEtag(conexao: ConnectionRecord, caminho: string): Promise<Pedido[]> {
  const chave = `${conexao.id}:${caminho}`
  const cache = cacheEtagPedidos.get(chave)

  const headers: Record<string, string> = { Authorization: `Bearer ${conexao.apiKey}` }
  if (cache) headers['If-None-Match'] = cache.etag

  let resposta: Resposta
  try {
    resposta = await http(`${conexao.apiBaseUrl}${caminho}`, { headers })
  } catch (erro) {
    anotarEstado(conexao.id, 'sem_rede')
    throw erro
  }
  if (resposta.dataServidor !== null) diferencaRelogioMs = resposta.dataServidor - Date.now()
  if (resposta.status === 304 && cache) {
    anotarEstado(conexao.id, 'ok')
    return cache.pedidos
  }
  if (!resposta.ok) {
    anotarEstado(conexao.id, resposta.status === 401 || resposta.status === 403 ? 'nao_autorizado' : 'erro_servidor')
    throw new ErroHttp(mensagemDeErro(resposta), resposta.status)
  }
  anotarEstado(conexao.id, 'ok')

  const pedidos = (Array.isArray(resposta.data) ? resposta.data : []) as Pedido[]
  if (resposta.etag) cacheEtagPedidos.set(chave, { etag: resposta.etag, pedidos })
  else cacheEtagPedidos.delete(chave)
  return pedidos
}

function porChegada(a: Pedido, b: Pedido): number {
  return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
}

async function buscarComStatusPorConexao(caminho: string): Promise<{ pedidos: Pedido[]; conexoesOk: Set<string> }> {
  const conexoes = getConnections()
  if (conexoes.length === 0) throw new Error('Configure a URL e o código da loja')

  const etiquetar = conexoes.length > 1
  const resultados = await Promise.allSettled(
    conexoes.map(async (conexao) => {
      const pedidos = await buscarPedidosComEtag(conexao, caminho)
      return pedidos.map((pedido) => ({
        ...pedido,
        connectionId: conexao.id,
        storeLabel: etiquetar ? conexao.label || 'Loja' : '',
      }))
    })
  )

  const juntos: Pedido[] = []
  const conexoesOk = new Set<string>()
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      juntos.push(...r.value)
      conexoesOk.add(conexoes[i].id)
    }
  })

  // Dois códigos da MESMA loja ligados neste tablet trariam cada pedido duas
  // vezes — dois cartões, duas comandas. O id é uuid: repetido é o mesmo pedido.
  const vistos = new Set<string>()
  const unicos = juntos.filter((pedido) => {
    const id = String(pedido.id ?? '')
    if (!id || vistos.has(id)) return false
    vistos.add(id)
    return true
  })

  // Todas falharam → erro, não lista vazia: lista vazia faria a próxima carga
  // boa tratar os pedidos de ontem como novos e reimprimir tudo.
  if (resultados.every((r) => r.status === 'rejected')) throw new Error('Nenhuma loja respondeu')

  return { pedidos: unicos.sort(porChegada), conexoesOk }
}

// ── Vigia de pedidos novos — RECUO em JS ──────────────────────────────────
// CONTRATO: esta regra existe em TRÊS cópias — electron/main.ts
// (vigiarPedidosNovos), aqui, e android/.../VigiaPedidosService.java (ciclo),
// que é quem roda de verdade no tablet. Mudou num, mude nos três. As
// diferenças deliberadas do nativo estão descritas no topo daquele arquivo.
const pedidosVistos = new Map<string, Set<string>>()
let primeiraVarredura = true
let vigiaEmAndamento = false
let timerVigia: ReturnType<typeof setTimeout> | null = null
const INTERVALO_VIGIA_MS = 7_000
const NOVO_PEDIDO_RECENTE_MS = 20 * 60 * 1000

function ehMarketplace(channel: string): boolean {
  return channel === 'ifood' || channel === '99food'
}

function deveImprimirCanal(channel: string, filtro: string): boolean {
  if (filtro === 'ifood') return ehMarketplace(channel)
  if (filtro === 'own') return !ehMarketplace(channel)
  return true
}

async function vigiarPedidosNovos() {
  let resultado: { pedidos: Pedido[]; conexoesOk: Set<string> }
  try {
    resultado = await buscarComStatusPorConexao('/api/desktop/orders')
  } catch {
    definirSaude(saudeDoRecuo())
    return // rede fora ou nenhuma loja ligada — tenta no próximo ciclo
  }

  const operacionais = resultado.pedidos.filter((p) => p.status !== 'awaiting_payment')
  const novos = primeiraVarredura
    ? []
    : operacionais.filter((p) => !pedidosVistos.get(String(p.connectionId ?? ''))?.has(String(p.id)))

  // Só refaz o "visto" de quem respondeu agora: a loja que piscou offline
  // mantém o que já sabíamos, senão tudo dela viraria novo na volta.
  for (const connId of resultado.conexoesOk) pedidosVistos.set(connId, new Set())
  for (const p of operacionais) pedidosVistos.get(String(p.connectionId ?? ''))?.add(String(p.id))
  primeiraVarredura = false

  pedidosAtualizados.emitir(operacionais)

  const autoPrint = config.autoPrint !== 'false'
  const vias = Number(normalizarVias(config.printCopies))

  for (const p of novos) {
    if (Date.now() - new Date(String(p.created_at)).getTime() > NOVO_PEDIDO_RECENTE_MS) continue

    const canal = String(p.channel ?? 'web')

    // O alerta sai ANTES da impressão: conectar na impressora leva um ou dois
    // segundos, e o som não pode esperar por isso.
    novoPedido.emitir({
      id: String(p.id),
      label: orderLabel(p as never),
      canal,
      customerName: String(p.customer_name ?? ''),
      isPickup: p.fulfillment_type === 'pickup',
    })

    if (autoPrint && config.printerName && deveImprimirCanal(canal, config.autoPrintChannels || 'all')) {
      void imprimir(p, vias, config.scannerReady === 'true')
    }
  }

  definirSaude(saudeDoRecuo())
}

// ── Vigia nativo: fila de impressão ───────────────────────────────────────
// O serviço nativo enfileira (persistido) o pedido novo que deve imprimir; aqui
// a fila é drenada quando chega o evento (app na frente) e quando o app volta
// à frente. Idempotente por id: o nativo não repete id na fila, e o que já foi
// tentado nesta sessão não é tentado de novo. A tentativa CONTA mesmo se falhar
// — repetir sozinho uma comanda que caiu no meio do envio dobraria o papel; a
// falha vai para a tela e a pessoa usa Imprimir no cartão.
const tentadosNestaSessao = new Set<string>()
let drenagem: Promise<void> | null = null
let drenarDeNovo = false

function drenarImpressao(): Promise<void> {
  if (!usarVigiaNativo) return Promise.resolve()
  if (drenagem) {
    drenarDeNovo = true
    return drenagem
  }
  drenagem = (async () => {
    do {
      drenarDeNovo = false
      let pendentes: PendenteImpressao[] = []
      try {
        pendentes = (await Vigia.pendentesDeImpressao()).pendentes ?? []
      } catch {
        return
      }
      for (const item of pendentes) {
        const id = String(item.id)
        if (!tentadosNestaSessao.has(id)) {
          tentadosNestaSessao.add(id)
          const canal = String(item.pedido?.channel ?? 'web')
          // As condições de hoje, conferidas de novo: a config pode ter mudado
          // entre o pedido chegar e o app voltar à frente.
          const imprime =
            config.autoPrint !== 'false' &&
            Boolean(config.printerName) &&
            deveImprimirCanal(canal, config.autoPrintChannels || 'all')
          if (imprime && item.pedido) {
            await imprimir(item.pedido, Number(normalizarVias(config.printCopies)), config.scannerReady === 'true')
          }
        }
        try {
          await Vigia.confirmarImpressos({ ids: [id] })
        } catch {
          // Fica na fila; tentadosNestaSessao impede a segunda tentativa.
        }
      }
    } while (drenarDeNovo)
  })().finally(() => {
    drenagem = null
  })
  return drenagem
}

/** App voltou à frente (ou acabou de abrir): estado, lista e fila de impressão. */
async function aoVoltarParaFrente() {
  try {
    const e = await Vigia.estado()
    if (e.pedidos) pedidosAtualizados.emitir(e.pedidos)
    if (e.saude) definirSaude(e.saude)
    if (!e.rodando && e.lojaPareada && e.ativo) await Vigia.iniciar()
    await Vigia.verificarAgora()
  } catch (erro) {
    console.error('Não consegui ler o estado do vigia nativo:', erro)
  }
  await drenarImpressao()
}

async function cicloDoVigia() {
  if (vigiaEmAndamento) return
  vigiaEmAndamento = true
  try {
    await vigiarPedidosNovos()
  } finally {
    vigiaEmAndamento = false
  }
}

function agendarVigia(atrasoMs = INTERVALO_VIGIA_MS) {
  if (timerVigia) clearTimeout(timerVigia)
  timerVigia = setTimeout(async () => {
    await cicloDoVigia()
    agendarVigia()
  }, atrasoMs)
}

// ── Conexões ──────────────────────────────────────────────────────────────
async function adicionarConexao(apiBaseUrl: string, token: string, label?: string): Promise<{ erro?: string }> {
  const url = apiBaseUrl.trim().replace(/\/+$/, '') || SERVIDOR_PADRAO
  const chave = token.trim()

  if (!chave) return { erro: 'Informe o código da loja' }
  const erroUrl = erroDeEndereco(url)
  if (erroUrl) return { erro: erroUrl }
  if (getConnections().some((c) => c.apiBaseUrl === url && c.apiKey === chave)) {
    return { erro: 'Esta loja já está ligada a este aparelho' }
  }

  const registro: ConnectionRecord = { id: `loja-${Date.now().toString(36)}`, apiBaseUrl: url, apiKey: chave }
  if (label?.trim()) registro.label = label.trim()
  config.connections.push(registro)
  await gravarConfig()
  return {}
}

async function parearPorCodigo(apiBaseUrl: string, codigo: string): Promise<{ erro?: string; storeName?: string | null }> {
  const url = apiBaseUrl.trim().replace(/\/+$/, '') || SERVIDOR_PADRAO
  const code = codigo.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')

  const erroUrl = erroDeEndereco(url)
  if (erroUrl) return { erro: erroUrl }
  if (code.length !== 8) return { erro: 'O código tem 8 caracteres' }

  let resposta: Resposta
  try {
    resposta = await http(`${url}/api/desktop/parear`, { method: 'POST', body: { code } })
  } catch {
    return { erro: 'Não foi possível falar com o servidor. Confira a internet.' }
  }

  const dados = resposta.data as { token?: string; storeName?: string | null; error?: string } | null
  if (!resposta.ok || !dados?.token) return { erro: dados?.error ?? 'Código inválido ou expirado' }

  const { erro } = await adicionarConexao(url, dados.token, dados.storeName ?? undefined)
  if (erro) return { erro }
  return { storeName: dados.storeName ?? null }
}

// ── A API em si ───────────────────────────────────────────────────────────
const api: Window['api'] = {
  plataforma: 'android',

  getConfig: async () => {
    const conexoes = getConnections()
    return {
      connections: conexoes.map((c) => ({ id: c.id, apiBaseUrl: c.apiBaseUrl, label: c.label || '' })),
      apiBaseUrl: conexoes[0]?.apiBaseUrl || '',
      desktopApiKeyConfigured: conexoes.length > 0,
      printerName: config.printerName || '',
      printerWidth: config.printerWidth || '58',
      autoPrint: config.autoPrint || 'true',
      autoPrintChannels: config.autoPrintChannels || 'all',
      printCopies: config.printCopies || '1',
      scannerReady: config.scannerReady === 'true' ? 'true' : 'false',
      // Não existe "iniciar com o sistema" no tablet; a tela esconde a opção.
      autoStart: 'false',
    }
  },

  saveConfig: async (input: DesktopConfigInput) => {
    config = {
      ...config,
      printerName: input.printerName ?? config.printerName,
      printerWidth: input.printerWidth ?? config.printerWidth,
      autoPrint: input.autoPrint ?? config.autoPrint,
      autoPrintChannels: input.autoPrintChannels ?? config.autoPrintChannels,
      printCopies: normalizarVias(input.printCopies ?? config.printCopies),
      scannerReady: (input.scannerReady ?? config.scannerReady) === 'true' ? 'true' : 'false',
    }
    await gravarConfig()
    return true
  },

  getPrinters: async () => {
    // `name` é o que fica salvo (o endereço, que não muda se alguém renomear a
    // impressora); `displayName` é o que a pessoa lê na lista.
    let dispositivos: { nome: string; endereco: string }[]
    try {
      dispositivos = (await ImpressoraBluetooth.listarPareadas()).dispositivos
    } catch (erro) {
      // Rejeita com `code` (SEM_PERMISSAO | BLUETOOTH_DESLIGADO) e uma mensagem
      // pronta: a tela distingue "libere a permissão" de "ligue o Bluetooth"
      // em vez de mostrar lista vazia. Ver cardapiaAndroid.motivoSemImpressoras.
      throw erroDeImpressoras(erro)
    }
    return dispositivos.map((d) => ({ name: d.endereco, displayName: d.nome || d.endereco }))
  },

  printOrder: async (order, includeReadyQr) => {
    const pedido = order as unknown as Pedido
    if (!config.printerName) return registrarSemImpressora(pedido)
    // Reimpressão pelo cartão sai com UMA via: quem toca quer a que faltou.
    return imprimir(pedido, 1, includeReadyQr ?? config.scannerReady === 'true')
  },

  fetchOrders: async () => (await buscarComStatusPorConexao('/api/desktop/orders')).pedidos as never,

  fetchOrderHistory: async (opts) => {
    const conexoes = getConnections()
    const etiquetar = conexoes.length > 1
    const offsets = opts.offsetsPorConexao ?? {}

    const resultados = await Promise.allSettled(
      conexoes.map(async (conexao) => {
        const params = new URLSearchParams({
          history: 'true',
          limit: String(opts.limit),
          offset: String(offsets[conexao.id] ?? 0),
        })
        if (opts.status) params.set('status', opts.status)
        const pedidos = await buscarPedidosComEtag(conexao, `/api/desktop/orders?${params.toString()}`)
        return pedidos.map((p) => ({
          ...p,
          connectionId: conexao.id,
          storeLabel: etiquetar ? conexao.label || 'Loja' : '',
        }))
      })
    )

    let totalAntesDoCorte = 0
    let algumaPaginaCheia = false
    const juntos: Pedido[] = []
    for (const r of resultados) {
      if (r.status !== 'fulfilled') continue
      totalAntesDoCorte += r.value.length
      if (r.value.length === opts.limit) algumaPaginaCheia = true
      juntos.push(...r.value)
    }

    return {
      orders: juntos.sort(porChegada).slice(0, opts.limit) as never,
      hasMore: totalAntesDoCorte > opts.limit || algumaPaginaCheia,
    }
  },

  updateOrderStatus: async (id, status, connectionId) => {
    try {
      const data = await desktopRequest<{ requested?: boolean; message?: string }>(
        `/api/desktop/orders/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: { status } },
        connectionId
      )
      return { ok: true, requested: Boolean(data?.requested), message: data?.message ?? null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Erro ao atualizar o pedido' }
    }
  },

  scanOrderReady: async (id, connectionId) => {
    const conexoes = connectionId ? getConnections().filter((c) => c.id === connectionId) : getConnections()
    if (conexoes.length === 0) return { ok: false, error: 'Configure a URL e o código da loja' }

    type Payload = { success: true; requested: boolean; label: string; channel: string; message: string | null }
    const tentativas = await Promise.allSettled(
      conexoes.map(async (conexao) => ({
        connectionId: conexao.id,
        payload: await desktopRequest<Payload>(
          `/api/desktop/orders/${encodeURIComponent(id)}/pronto-scan`,
          { method: 'POST' },
          conexao.id
        ),
      }))
    )

    for (const t of tentativas) {
      if (t.status === 'fulfilled') return { ok: true, ...t.value.payload, connectionId: t.value.connectionId }
    }

    const mensagens = tentativas
      .filter((t): t is PromiseRejectedResult => t.status === 'rejected')
      .map((t) => (t.reason instanceof Error ? t.reason.message : String(t.reason)))
    const erroReal = mensagens.find((m) => m !== 'Pedido não encontrado nesta loja')
    return {
      ok: false,
      error: erroReal ?? 'Comanda escaneada, mas o pedido não foi encontrado nas lojas deste aparelho',
    }
  },

  getCatalogo: async (connectionId) => {
    try {
      const data = await desktopRequest<{ categorias: never[] }>('/api/desktop/catalogo', {}, connectionId)
      return { ok: true, categorias: data.categorias ?? [] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Erro ao carregar o cardápio' }
    }
  },

  criarPedidoBalcao: async (pedido, connectionId) => {
    try {
      const data = await desktopRequest<{ orderId: string; totalCents: number }>(
        '/api/desktop/orders',
        { method: 'POST', body: pedido },
        connectionId
      )
      // Não espera o próximo ciclo: quem fechou o pedido quer vê-lo no quadro.
      if (usarVigiaNativo) void Vigia.verificarAgora().catch(() => {})
      else void cicloDoVigia()
      return { ok: true, orderId: data.orderId, totalCents: data.totalCents }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Não foi possível criar o pedido' }
    }
  },

  acknowledgeOrder: async (id, connectionId) => {
    try {
      await desktopRequest(`/api/desktop/orders/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }, connectionId)
      return true
    } catch {
      return false
    }
  },

  getIfoodCancelReasons: (id, connectionId) =>
    tentar(async () => {
      const data = await desktopRequest<{ reasons: { code: string; description: string }[] }>(
        `/api/desktop/orders/${encodeURIComponent(id)}/cancelar`,
        {},
        connectionId
      )
      return { reasons: data.reasons ?? [] }
    }, 'Erro ao carregar motivos'),

  requestIfoodCancel: (id, code, description, connectionId) =>
    tentar(async () => {
      await desktopRequest(
        `/api/desktop/orders/${encodeURIComponent(id)}/cancelar`,
        { method: 'POST', body: { code, description } },
        connectionId
      )
      return {}
    }, 'O iFood recusou o cancelamento'),

  getStorePauseState: (connectionId) =>
    tentar(
      async () => (await desktopRequest<object>('/api/desktop/pausa', {}, connectionId)) ?? {},
      'Erro ao consultar a loja'
    ),

  setStorePause: (body, connectionId) =>
    tentar(async () => {
      await desktopRequest('/api/desktop/pausa', { method: 'POST', body }, connectionId)
      return {}
    }, 'Não foi possível concluir'),

  getIfoodDisputes: async () => {
    const conexoes = getConnections()
    const etiquetar = conexoes.length > 1
    const resultados = await Promise.allSettled(
      conexoes.map(async (c) => {
        const r = await desktopRequest<{ disputas: Pedido[] }>('/api/desktop/ifood/disputas', {}, c.id)
        return (r.disputas ?? []).map((d) => ({
          ...d,
          connectionId: c.id,
          storeLabel: etiquetar ? c.label || 'Loja' : '',
        }))
      })
    )
    const disputas: Pedido[] = []
    for (const r of resultados) if (r.status === 'fulfilled') disputas.push(...r.value)
    return { disputas: disputas as never }
  },

  respondIfoodDispute: (disputeId, resposta, motivo, connectionId) =>
    tentar(async () => {
      await desktopRequest(
        '/api/desktop/ifood/disputas',
        { method: 'POST', body: { disputeId, resposta, motivo } },
        connectionId
      )
      return {}
    }, 'Não foi possível responder a disputa'),

  onPrintError: (cb) => erroDeImpressao.assinar(cb),
  onFalhaImpressao: (cb) => falhaDeImpressao.assinar(cb),
  onSaude: (cb) => {
    const cancelar = saude.assinar(cb)
    if (ultimaSaude) cb(ultimaSaude)
    return cancelar
  },
  onNewOrder: (cb) => novoPedido.assinar(cb),
  onOrdersUpdated: (cb) => pedidosAtualizados.assinar(cb as unknown as (orders: Pedido[]) => void),

  getStores: async () => {
    const conexoes = getConnections()
    const nomes = await Promise.allSettled(
      conexoes.map((c) =>
        desktopRequest<{ storeName: string | null; ifoodConectado?: boolean; ifoodPollingParadoSegundos?: number | null }>(
          '/api/desktop/loja',
          {},
          c.id
        )
      )
    )

    let mudou = false
    const resultado = conexoes.map((c, i) => {
      const r = nomes[i]
      const nome = r.status === 'fulfilled' ? r.value.storeName : null
      // O nome vem do servidor e fica guardado: é a etiqueta de cada pedido.
      if (nome && nome !== c.label) {
        c.label = nome
        mudou = true
      }
      return {
        id: c.id,
        storeName: nome ?? c.label ?? null,
        online: r.status === 'fulfilled',
        ifoodConectado: r.status === 'fulfilled' ? Boolean(r.value.ifoodConectado) : false,
        ifoodPollingParadoSegundos: r.status === 'fulfilled' ? r.value.ifoodPollingParadoSegundos ?? null : null,
      }
    })

    if (mudou) await gravarConfig()
    return resultado
  },

  addConnection: (url, token) => adicionarConexao(url, token),
  pairDevice: (url, code) => parearPorCodigo(url, code),

  removeConnection: async (id) => {
    config.connections = config.connections.filter((c) => c.id !== id)
    await gravarConfig()
    for (const chave of [...cacheEtagPedidos.keys()]) {
      if (chave.startsWith(`${id}:`)) cacheEtagPedidos.delete(chave)
    }
    pedidosVistos.delete(id)
    estadosJs.delete(id)
    return { ok: true }
  },

  getWhatsappStatus: async () => {
    const conexoes = getConnections()
    const etiquetar = conexoes.length > 1

    const resultados = await Promise.allSettled(
      conexoes.map(async (c) => {
        const r = await desktopRequest<{ conversations: Pedido[]; connectionState: string }>(
          '/api/desktop/whatsapp/status',
          {},
          c.id
        )
        const storeLabel = etiquetar ? c.label || 'Loja' : ''
        return {
          connectionId: c.id,
          storeLabel,
          connectionState: r.connectionState,
          conversations: (r.conversations ?? []).map((conv) => ({ ...conv, connectionId: c.id, storeLabel })),
        }
      })
    )

    const conversations: Pedido[] = []
    const connectionStates: { connectionId: string; storeLabel: string; state: string }[] = []
    for (const r of resultados) {
      if (r.status !== 'fulfilled') continue
      conversations.push(...r.value.conversations)
      connectionStates.push({
        connectionId: r.value.connectionId,
        storeLabel: r.value.storeLabel,
        state: r.value.connectionState,
      })
    }

    conversations.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return { conversations: conversations as never, connectionStates }
  },

  getWhatsappMessages: (conversationId, connectionId) =>
    desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`, {}, connectionId),

  sendWhatsappReply: async (conversationId, message, connectionId) => {
    await desktopRequest(
      `/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/reply`,
      { method: 'POST', body: { message } },
      connectionId
    )
    return true
  },

  resumeWhatsappBot: async (conversationId, connectionId) => {
    await desktopRequest(
      `/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/resume-bot`,
      { method: 'POST' },
      connectionId
    )
    return true
  },

  markWhatsappConversationSeen: async (conversationId, connectionId) => {
    await desktopRequest(
      `/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/seen`,
      { method: 'POST' },
      connectionId
    )
    return true
  },

  getNotificationSounds: async () => {
    try {
      return await desktopRequest('/api/desktop/notification-sounds')
    } catch {
      return { orderSoundUrl: null, messageSoundUrl: null, driverSoundUrl: null }
    }
  },

  // Não há janela para controlar no Android; a barra esconde esses botões.
  minimizeWindow: async () => {},
  toggleMaximizeWindow: async () => true,
  isWindowMaximized: async () => true,
  closeWindow: async () => {},
  onWindowMaximizedChange: () => () => {},
}

// ── Erros da lista de impressoras ─────────────────────────────────────────
const MOTIVOS_SEM_IMPRESSORAS: string[] = ['SEM_PERMISSAO', 'BLUETOOTH_DESLIGADO']

function erroDeImpressoras(erro: unknown): Error {
  const codigo = codigoDoErro(erro)
  if (codigo === 'SEM_PERMISSAO') {
    return Object.assign(new Error('Não deu para listar as impressoras · o Cardapia não tem a permissão de dispositivos próximos'), { code: codigo })
  }
  if (codigo === 'BLUETOOTH_DESLIGADO') {
    return Object.assign(new Error('Não deu para listar as impressoras · o Bluetooth do tablet está desligado'), { code: codigo })
  }
  return erro instanceof Error ? erro : new Error('Não deu para listar as impressoras')
}

// ── window.cardapiaAndroid (só no APK) ────────────────────────────────────
async function lerSaudeDoBalcao(): Promise<SaudeDoBalcao> {
  const r: SaudeDoBalcao = {
    nativo: usarVigiaNativo,
    notificacoes: false,
    isentoBateria: false,
    podeTelaCheia: false,
    vigiaRodando: false,
    lojaPareada: getConnections().length > 0,
    bluetoothExiste: false,
    bluetoothLigado: false,
    bluetoothPermitido: false,
    telaLigada: true,
  }
  if (usarVigiaNativo) {
    try {
      const e = await Vigia.estado()
      r.notificacoes = e.notificacoes
      r.isentoBateria = e.isentoBateria
      r.podeTelaCheia = e.podeTelaCheia
      r.vigiaRodando = e.rodando
      r.lojaPareada = e.lojaPareada
      r.telaLigada = e.telaLigada
    } catch {
      // Fica tudo como "não": a tela mostra o botão de corrigir.
    }
  }
  try {
    const b = await ImpressoraBluetooth.estado()
    r.bluetoothExiste = b.existe
    r.bluetoothLigado = b.ligado
    r.bluetoothPermitido = b.permitido
  } catch {
    // Sem o plugin: fica como "não".
  }
  return r
}

const cardapiaAndroid: CardapiaAndroidApi = {
  saudeDoBalcao: lerSaudeDoBalcao,
  pedirPermissaoNotificacao: async () => {
    if (!usarVigiaNativo) return false
    try {
      return (await Vigia.pedirPermissaoNotificacao()).permitido
    } catch {
      return false
    }
  },
  pedirIsencaoBateria: async () => {
    if (usarVigiaNativo) await Vigia.pedirIsencaoBateria().catch(() => {})
  },
  abrirAjusteTelaCheia: async () => {
    if (usarVigiaNativo) await Vigia.abrirAjusteTelaCheia().catch(() => {})
  },
  abrirAjustesDoApp: async () => {
    if (usarVigiaNativo) await Vigia.abrirAjustesDoApp().catch(() => {})
  },
  pedirPermissaoBluetooth: async () => {
    try {
      return (await ImpressoraBluetooth.pedirPermissao()).permitido
    } catch {
      return false
    }
  },
  manterTelaLigada: async (ligar) => {
    if (usarVigiaNativo) await Vigia.manterTelaLigada({ ligar }).catch(() => {})
  },
  reiniciarVigia: async () => {
    if (!usarVigiaNativo) return
    await sincronizarVigia()
    await Vigia.iniciar().catch(() => {})
    await aoVoltarParaFrente()
  },
  motivoSemImpressoras: (erro) => {
    const codigo = codigoDoErro(erro)
    return MOTIVOS_SEM_IMPRESSORAS.includes(codigo) ? (codigo as MotivoSemImpressoras) : null
  },
}

/** Carrega a config, publica `window.api` e liga o vigia. Chamar ANTES de montar a interface. */
export async function instalarApiAndroid() {
  await carregarConfig()
  window.api = api
  if (Capacitor.isNativePlatform()) window.cardapiaAndroid = cardapiaAndroid

  if (usarVigiaNativo) {
    // O vigia nativo decide o que é novo; aqui só se escuta.
    await Vigia.addListener('pedidosAtualizados', (d) => pedidosAtualizados.emitir(d.pedidos ?? []))
    await Vigia.addListener('novoPedido', (d) => {
      // Aviso primeiro (som + toast na tela), impressão depois — conectar na
      // impressora leva um ou dois segundos e o som não espera.
      novoPedido.emitir(d.info)
      if (d.imprimir) void drenarImpressao()
    })
    await Vigia.addListener('saude', (d) => definirSaude(d))

    // Manda a config (e o token, que o nativo guarda cifrado) a cada abertura:
    // é também o que conserta um cofre que não abriu.
    await sincronizarVigia()
    await Vigia.iniciar().catch((erro) => console.error('Não consegui ligar o vigia nativo:', erro))
    void aoVoltarParaFrente()

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void aoVoltarParaFrente()
    })
  } else {
    agendarVigia(2_000)

    // Ao voltar para a tela (com a página oculta o Chromium estrangula os
    // timers), busca na hora em vez de esperar o ciclo que ficou congelado.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void cicloDoVigia()
        agendarVigia()
      }
    })
  }

  setTimeout(() => void reportarDiagnostico(), 30_000)
  setInterval(() => void reportarDiagnostico(), 5 * 60 * 1000)
}
