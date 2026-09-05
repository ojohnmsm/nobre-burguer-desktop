import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, dialog, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { buildReceiptEscPos, buildReceiptHtml, printRawEscPos, ImpressaoAmbiguaError, prewarmHostImpressao, encerrarHostImpressao } from './escpos'
import { orderLabel, origemLabel } from './receiptFormat'
import { pastaDoLog, registrar } from './log'

// ── Atualização automática ────────────────────────────────────────────────
// O instalador e o latest.yml ficam nas releases do GitHub, conforme
// `build.publish` no package.json. O comentário anterior falava de um bucket do
// Supabase e de um script que não existem mais — descrição de um jeito antigo
// de publicar, mantida por descuido.
//
// Nunca baixa nem instala sem perguntar: quem está no balcão pode estar no meio
// do movimento, e reiniciar o programa sozinho perderia a tela de pedidos.
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

autoUpdater.on('update-available', (info) => {
  if (!mainWindow) return
  void dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Atualização disponível',
    message: `Uma nova versão (${info.version}) do Cardapia está disponível.`,
    detail: 'Deseja baixar e instalar agora? Isso reinicia o app.',
    buttons: ['Atualizar agora', 'Mais tarde'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) void autoUpdater.downloadUpdate()
  })
})

autoUpdater.on('update-downloaded', (info) => {
  if (!mainWindow) return
  void dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Atualização pronta',
    message: `Versão ${info.version} baixada. O app vai reiniciar para instalar.`,
    buttons: ['Reiniciar agora'],
  }).then(() => {
    isQuitting = true
    autoUpdater.quitAndInstall()
  })
})

/**
 * Distingue a checagem automática (silenciosa quando não há novidade) da
 * pedida na hora pelo menu (que precisa responder algo sempre, ou vira um
 * botão que parece não fazer nada).
 *
 * Motivo de existir: fechar a janela não encerra o programa — ele esconde para
 * a bandeja — e a checagem automática só roda 5s depois do PROCESSO nascer e
 * depois a cada 4h. Um Cardapia aberto desde antes de uma versão nova existir
 * fica sem saber disso até alguém sair de verdade (bandeja → Sair) e reabrir,
 * ou até a próxima janela de 4h. Sem um jeito manual de perguntar agora, não dá
 * como confirmar se a atualização está de fato funcionando.
 */
let verificacaoManual = false

autoUpdater.on('update-not-available', () => {
  if (!verificacaoManual || !mainWindow) return
  verificacaoManual = false
  void dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Sem atualização',
    message: 'Você já está na versão mais recente.',
  })
})

autoUpdater.on('error', (error) => {
  console.error('Erro ao verificar atualização:', error)
  if (!verificacaoManual || !mainWindow) return
  verificacaoManual = false
  void dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Não foi possível verificar',
    message: 'Confira a conexão com a internet e tente de novo.',
  })
})

function checkForUpdates(manual = false) {
  if (manual) verificacaoManual = true
  autoUpdater.checkForUpdates().catch((error) => {
    console.error('Erro ao checar atualização:', error)
    if (manual) verificacaoManual = false
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let printWindow: BrowserWindow | null = null
let isQuitting = false

function loadTrayIcon() {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  const icon = nativeImage.createFromPath(path)

  if (!icon.isEmpty()) return icon.resize({ width: 32, height: 32 })

  // O arquivo da marca deveria sempre existir. Este recuo mantém uma bandeja
  // identificável caso a instalação seja interrompida antes de copiar o asset.
  return nativeImage.createFromDataURL(`data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#D97706"/><path fill="white" d="M9 11h14v3H9zm2 5h10v3H11zm2 5h6v3h-6z"/></svg>'
  )}`)
}

// ── Config (saved via ipcMain, persisted to userData) ──────────────────────
const CONFIG_PATH = join(app.getPath('userData'), 'config.json')

function loadConfig(): Record<string, string> {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}

function saveConfig(cfg: Record<string, string>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function readDesktopApiKey(config: Record<string, string>): string {
  const encrypted = config.desktopApiKeyEncrypted
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim()
    } catch {
      // Treat a value encrypted for a different OS user/profile as unavailable.
      return ''
    }
  }

  // Compatibility with installations configured before the protected format.
  return config.desktopApiKey?.trim() || ''
}

function storeDesktopApiKey(config: Record<string, string>, token: string) {
  if (safeStorage.isEncryptionAvailable()) {
    config.desktopApiKeyEncrypted = safeStorage.encryptString(token).toString('base64')
    delete config.desktopApiKey
    return
  }

  // Electron uses the operating system's encrypted credential store on Windows.
  // The fallback keeps the app functional only on platforms where it is absent.
  config.desktopApiKey = token
  delete config.desktopApiKeyEncrypted
}

/**
 * UMA loja ligada a este computador.
 *
 * O aplicativo guardava uma conexão só — um endereço e um código. Duas lojas no
 * mesmo balcão é caso real: cada uma tem cardápio, atendente, WhatsApp e conta
 * de recebimento próprios, mas quem prepara é a mesma cozinha.
 */
export interface StoreConnection {
  /** Estável, gerado uma vez. É por ele que o pedido sabe para onde voltar. */
  id: string
  apiBaseUrl: string
  desktopApiKey: string
  /** Nome vindo do servidor. Usado nas etiquetas de cada pedido na tela. */
  label: string
}

interface ConnectionRecord {
  id: string
  apiBaseUrl: string
  apiKeyEncrypted?: string
  apiKey?: string
  label?: string
}

function decodeKey(record: ConnectionRecord): string {
  if (record.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(record.apiKeyEncrypted, 'base64')).trim()
    } catch {
      // Cifrado para outro usuário do sistema: indisponível, não corrompido.
      return ''
    }
  }
  return record.apiKey?.trim() || ''
}

function encodeKey(record: ConnectionRecord, token: string) {
  if (safeStorage.isEncryptionAvailable()) {
    record.apiKeyEncrypted = safeStorage.encryptString(token).toString('base64')
    delete record.apiKey
    return
  }
  record.apiKey = token
  delete record.apiKeyEncrypted
}

function urlValida(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Lê a lista de conexões, MIGRANDO a configuração antiga de uma loja só.
 *
 * A migração acontece na leitura e não numa rotina à parte: quem já tem o
 * aplicativo instalado abre e continua funcionando, sem reconfigurar nada. Sem
 * isso, a atualização apagaria a conexão existente e o balcão pararia de
 * receber pedido até alguém digitar o código de novo.
 */
function readConnections(): ConnectionRecord[] {
  const config = loadConfig() as Record<string, unknown>

  const lista = config.connections
  if (Array.isArray(lista) && lista.length > 0) return lista as ConnectionRecord[]

  const apiBaseUrl = String(config.apiBaseUrl ?? '').trim().replace(/\/+$/, '')
  const legado = readDesktopApiKey(config as Record<string, string>)
  if (!apiBaseUrl || !legado) return []

  const migrada: ConnectionRecord = { id: 'principal', apiBaseUrl }
  encodeKey(migrada, legado)
  return [migrada]
}

function writeConnections(lista: ConnectionRecord[]) {
  const config = loadConfig() as Record<string, unknown>
  config.connections = lista
  // Os campos antigos saem para não existirem duas verdades sobre a mesma
  // conexão — se ficassem, uma edição futura poderia gravar num e ler do outro.
  delete config.apiBaseUrl
  delete config.desktopApiKey
  delete config.desktopApiKeyEncrypted
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function getConnections(): StoreConnection[] {
  return readConnections()
    .map((r) => ({
      id: r.id,
      apiBaseUrl: r.apiBaseUrl?.trim().replace(/\/+$/, '') ?? '',
      desktopApiKey: decodeKey(r),
      label: r.label ?? '',
    }))
    .filter((c) => c.apiBaseUrl && c.desktopApiKey && urlValida(c.apiBaseUrl))
}

/** A conexão de um id — ou a primeira, para o que ainda não é por loja. */
function getConnection(connectionId?: string): StoreConnection | null {
  const todas = getConnections()
  if (!connectionId) return todas[0] ?? null
  return todas.find((c) => c.id === connectionId) ?? null
}

interface DesktopConfigInput {
  apiBaseUrl?: string
  desktopApiKey?: string
  printerName?: string
  /** '58' (32 colunas) ou '80' (48 colunas). */
  printerWidth?: string
  autoPrint?: string
  /** 'all' | 'own' | 'ifood' — quais canais a impressão automática imprime. */
  autoPrintChannels?: string
  /** Quantas comandas sair por pedido: '1' a '3'. */
  printCopies?: string
  autoStart?: string
}

function getConfigView() {
  const config = loadConfig()
  const conexoes = getConnections()
  return {
    // Lista, e não uma conexão: duas lojas no mesmo balcão é caso real.
    connections: conexoes.map((c) => ({
      id: c.id,
      apiBaseUrl: c.apiBaseUrl,
      label: c.label || '',
    })),
    // Mantidos para a tela saber se há QUALQUER loja configurada sem precisar
    // conhecer o formato da lista.
    apiBaseUrl: conexoes[0]?.apiBaseUrl || '',
    desktopApiKeyConfigured: conexoes.length > 0,
    printerName: config.printerName || '',
    printerWidth: config.printerWidth || '58',
    autoPrint: config.autoPrint || 'true',
    autoPrintChannels: config.autoPrintChannels || 'all',
    printCopies: config.printCopies || '1',
    autoStart: config.autoStart || 'true',
  }
}

/**
 * Preferências da máquina — impressora, impressão automática, iniciar junto.
 *
 * NÃO mexe mais em conexão. Endereço e código passaram a ser lista, e tratá-los
 * aqui misturaria "ajuste desta máquina" com "a quais lojas ela atende", que
 * têm ciclos de vida diferentes: a impressora é do balcão, a loja é do negócio.
 */
function saveConfigInput(input: DesktopConfigInput) {
  const current = loadConfig()
  const next: Record<string, string> = {
    ...current,
    printerName: input.printerName ?? current.printerName ?? '',
    printerWidth: input.printerWidth ?? current.printerWidth ?? '58',
    autoPrint: input.autoPrint ?? current.autoPrint ?? 'true',
    autoPrintChannels: input.autoPrintChannels ?? current.autoPrintChannels ?? 'all',
    printCopies: normalizarVias(input.printCopies ?? current.printCopies),
    autoStart: input.autoStart ?? current.autoStart ?? 'true',
  }
  saveConfig(next)
  return next
}

/**
 * Onde a Cardapia mora.
 *
 * O código da loja já identifica a loja E o servidor que a hospeda — pedir o
 * endereço junto era expor detalhe de infraestrutura a quem só quer ligar o
 * balcão. O campo continua existindo para quem roda em domínio próprio ou numa
 * instalação separada, mas em branco resolve para cá.
 */
const SERVIDOR_PADRAO = 'https://www.cardapia.shop'

/** Liga mais uma loja a este computador. */
function adicionarConexao(apiBaseUrl: string, desktopApiKey: string, label?: string): { erro?: string } {
  const url = apiBaseUrl.trim().replace(/\/+$/, '') || SERVIDOR_PADRAO
  const token = desktopApiKey.trim()

  if (!token) return { erro: 'Informe o código da loja' }
  if (!urlValida(url)) return { erro: 'Endereço inválido' }

  const lista = readConnections()

  // Mesmo código na mesma máquina seria a mesma loja duas vezes: pedidos
  // duplicados na tela e som tocando em dobro.
  const jaExiste = getConnections().some(
    (c) => c.apiBaseUrl === url && c.desktopApiKey === token
  )
  if (jaExiste) return { erro: 'Esta loja já está ligada a este computador' }

  const registro: ConnectionRecord = {
    id: `loja-${Date.now().toString(36)}`,
    apiBaseUrl: url,
  }
  if (label?.trim()) registro.label = label.trim()
  encodeKey(registro, token)
  lista.push(registro)
  writeConnections(lista)
  return {}
}

/**
 * Troca o código CURTO de pareamento pelo token longo, e liga a loja.
 *
 * É este caminho que resolve a instalação de cozinha: o computador do balcão
 * costuma não ter navegador, e o token real tem 47 caracteres. Aqui a pessoa
 * digita 8 e o token nunca aparece na tela — vai direto do servidor para o cofre
 * do sistema operacional, em `encodeKey`.
 */
async function parearPorCodigo(
  apiBaseUrl: string,
  codigo: string
): Promise<{ erro?: string; storeName?: string | null }> {
  const url = apiBaseUrl.trim().replace(/\/+$/, '') || SERVIDOR_PADRAO
  const code = codigo.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')

  if (!urlValida(url)) return { erro: 'Endereço inválido' }
  if (code.length !== 8) return { erro: 'O código tem 8 caracteres' }

  let resposta: Response
  try {
    resposta = await fetch(`${url}/api/desktop/parear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  } catch {
    return { erro: 'Não foi possível falar com o servidor. Confira a internet.' }
  }

  const dados = (await resposta.json().catch(() => null)) as
    | { token?: string; storeName?: string | null; error?: string }
    | null

  if (!resposta.ok || !dados?.token) {
    return { erro: dados?.error ?? 'Código inválido ou expirado' }
  }

  const { erro } = adicionarConexao(url, dados.token, dados.storeName ?? undefined)
  if (erro) return { erro }

  return { storeName: dados.storeName ?? null }
}

function removerConexao(id: string) {
  writeConnections(readConnections().filter((c) => c.id !== id))
  // Sem isto, o cache de ETag desta conexão fica pra sempre no Map, sem
  // nenhum lookup futuro que o alcance — inofensivo, mas por que deixar.
  for (const chave of [...cacheEtagPedidos.keys()]) {
    if (chave.startsWith(`${id}:`)) cacheEtagPedidos.delete(chave)
  }
}

function getDesktopConnection() {
  return getConnection()
}

async function desktopRequest<T>(
  path: string,
  init: RequestInit = {},
  connectionId?: string
): Promise<T> {
  const connection = getConnection(connectionId)
  if (!connection) throw new Error('Configure a URL e o código da loja')

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${connection.desktopApiKey}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${connection.apiBaseUrl}${path}`, { ...init, headers })
  const payload = await response.json().catch(() => null) as { error?: string } | T | null

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `Servidor respondeu ${response.status}`
    throw new Error(message)
  }

  return payload as T
}

// ── Impressão da comanda ─────────────────────────────────────────────────
// Caminho primário: ESC/POS cru pelo spooler do Windows (electron/escpos.ts) —
// ignora o driver, que numa térmica assume A4/Carta e desperdiça papel.
// Fallback: HTML via BrowserWindow oculta (buildReceiptHtml + chromiumPrint).


// ── FALLBACK: Chromium webContents.print (HTML) ───────────────────────────
function chromiumPrint(order: Record<string, unknown>, printerName: string, widthCols: 32 | 48): Promise<void> {
  return new Promise((resolve, reject) => {
    if (printWindow) { printWindow.destroy(); printWindow = null }

    const tmpFile = join(app.getPath('temp'), `nobre-receipt-${randomUUID()}.html`)
    writeFileSync(tmpFile, buildReceiptHtml(order, widthCols), 'utf-8')

    printWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })

    const cleanup = () => {
      try { unlinkSync(tmpFile) } catch { /* ignore */ }
      printWindow?.destroy()
      printWindow = null
    }

    printWindow.webContents.once('did-fail-load', (_event, _code, description) => {
      cleanup()
      reject(new Error(description))
    })

    printWindow.loadFile(tmpFile)
    printWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        printWindow?.webContents.print(
          {
            silent: true,
            deviceName: printerName,
            // Largura do rolo; altura curta para o fallback não avançar meia
            // folha como o caminho antigo fazia.
            pageSize: { width: widthCols === 48 ? 80000 : 58000, height: 200000 },
            margins: { marginType: 'none' },
            printBackground: false,
            color: false,
          },
          (success, failureReason) => {
            if (!success) {
              const message = failureReason
                ? `${failureReason} (impressora: "${printerName}")`
                : `Falha desconhecida (impressora: "${printerName}")`
              // Só registra. Quem avisa a tela é quem chamou — lá se sabe se a
              // comanda ainda tem outro caminho para sair, e por isso se sabe se
              // há algo para o balcão fazer. Avisar aqui mandava a mensagem do
              // Chromium, em inglês, junto com o nome da fila de impressão.
              registrar('erro', 'Impressão em HTML recusada pelo Chromium', message)
              cleanup()
              reject(new Error(message))
              return
            }
            cleanup()
            resolve()
          },
        )
      }, 500)
    })
  })
}

/**
 * Vias por pedido, entre 1 e 3.
 *
 * Recorta para 1 em qualquer valor estranho (vazio, texto, zero, negativo). O
 * erro que importa evitar aqui é imprimir DEMAIS: papel gasto e cozinha
 * confusa. Imprimir de menos a pessoa percebe na hora e reimprime pelo cartão.
 */
function normalizarVias(valor: string | undefined): string {
  const n = Number.parseInt(String(valor ?? '1'), 10)
  if (!Number.isFinite(n) || n < 1) return '1'
  return String(Math.min(n, 3))
}

// ── Entry point: ESC/POS cru primeiro, HTML como reserva ────────────────
async function autoPrintOrder(
  order: Record<string, unknown>,
  printerName: string,
  widthCols: 32 | 48,
  vias = 1
) {
  const pedido = `#${orderLabel(order as never)}`

  for (let i = 0; i < vias; i += 1) {
    try {
      await printRawEscPos(buildReceiptEscPos(order, widthCols), printerName)
    } catch (escposError) {
      // Dúvida NÃO vira reimpressão. Era isto que dobrava a comanda: o ESC/POS
      // estourava o tempo-limite depois de já ter mandado os bytes, e a reserva
      // em HTML imprimia por cima.
      if (escposError instanceof ImpressaoAmbiguaError) {
        registrar('erro', `Impressão sem confirmação do pedido ${pedido}`, escposError)
        // Aqui o lojista PRECISA agir: pode não ter saído papel nenhum.
        mainWindow?.webContents.send(
          'print-error',
          `Confira se a comanda do pedido ${pedido} saiu. Se não saiu, use Imprimir no cartão.`
        )
        return
      }

      // A reserva imprime um cupom IDÊNTICO ao do ESC/POS, então a comanda sai
      // certa e a cozinha não tem nada a fazer — por isso nada vai para a tela.
      // O motivo técnico não ajuda quem está montando pedido; vai para o log.
      registrar('erro', `ESC/POS falhou no pedido ${pedido}, usando a reserva em HTML`, escposError)
      try {
        await chromiumPrint(order, printerName, widthCols)
        registrar('info', `Reserva em HTML imprimiu o pedido ${pedido}`)
      } catch (htmlError) {
        // Os DOIS caminhos falharam: não saiu comanda nenhuma. Agora sim é
        // problema do balcão, e a mensagem diz o que fazer, não o que houve.
        registrar('erro', `Reserva em HTML também falhou no pedido ${pedido}`, htmlError)
        mainWindow?.webContents.send(
          'print-error',
          `A comanda do pedido ${pedido} não saiu. Use Imprimir no cartão do pedido.`
        )
      }
    }
  }
}

// ── IPC Handlers ──────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => getConfigView())

ipcMain.handle('add-connection', (_e, apiBaseUrl: string, desktopApiKey: string) => {
  return adicionarConexao(apiBaseUrl, desktopApiKey)
})

ipcMain.handle('pair-device', async (_e, apiBaseUrl: string, codigo: string) => {
  return parearPorCodigo(apiBaseUrl, codigo)
})

ipcMain.handle('remove-connection', (_e, id: string) => {
  removerConexao(id)
  return { ok: true }
})

ipcMain.handle('save-config', (_e, input: DesktopConfigInput) => {
  const config = saveConfigInput(input)
  try {
    app.setLoginItemSettings({ openAtLogin: config.autoStart === 'true', path: app.getPath('exe') })
  } catch { /* ignore — can fail in dev/unpacked builds */ }
  return true
})

ipcMain.handle('get-notification-sounds', async () => {
  try {
    return await desktopRequest<{ orderSoundUrl: string | null; messageSoundUrl: string | null; driverSoundUrl: string | null }>('/api/desktop/notification-sounds')
  } catch {
    return { orderSoundUrl: null, messageSoundUrl: null, driverSoundUrl: null }
  }
})

ipcMain.handle('get-printers', async () => {
  const list = await mainWindow?.webContents.getPrintersAsync() ?? []
  // Log printer names to help diagnose deviceName issues
  console.log('Available printers:', list.map(p => ({ name: p.name, displayName: p.displayName })))
  return list
})

ipcMain.handle('print-order', async (_e, order: Record<string, unknown>) => {
  const cfg = loadConfig()
  if (!cfg.printerName) return 'no-printer'
  const widthCols = cfg.printerWidth === '80' ? 48 : 32
  try {
    // Reimpressão pedida no cartão sai com UMA via de propósito: quem clica
    // quer a comanda que faltou, não outro par delas.
    await autoPrintOrder(order, cfg.printerName, widthCols)
    return 'ok'
  } catch (error) {
    // autoPrintOrder já trata (e avisa) as falhas de impressão que conhece; o
    // que chega aqui é o inesperado. O motivo vai para o log e a tela recebe a
    // única coisa acionável: tentar de novo.
    registrar('erro', 'Falha inesperada ao reimprimir pelo cartão', error)
    mainWindow?.webContents.send('print-error', 'Não foi possível imprimir. Tente de novo.')
    return 'error'
  }
})

interface BuscaResultado {
  pedidos: Record<string, unknown>[]
  /** Ids das conexões que responderam NESTE ciclo — ver vigiarPedidosNovos(). */
  conexoesOk: Set<string>
}

/**
 * Cache de ETag por (conexão, caminho) — histórico paginado e o kanban usam o
 * mesmo mecanismo, cada página com sua própria chave.
 */
const cacheEtagPedidos = new Map<string, { etag: string; pedidos: Record<string, unknown>[] }>()

/**
 * Busca pedidos com resposta condicional: manda o ETag da última vez, e a
 * rota devolve 304 sem corpo quando nada mudou desde então — sem passar pela
 * consulta cara (order_items, entregador do iFood, prep target). Na prática a
 * maioria dos ciclos do vigia não encontra nada novo, então a maioria das
 * respostas vira só um 304 vazio.
 *
 * Separado de desktopRequest() de propósito: aquele é genérico para todas as
 * rotas do desktop, e só esta entende ETag — misturar o cache aqui dentro
 * complicaria o contrato das outras dezenas de chamadas que não têm nada a
 * ver com isso.
 */
async function buscarPedidosComEtag(
  conexao: StoreConnection,
  caminho: string
): Promise<Record<string, unknown>[]> {
  const chave = `${conexao.id}:${caminho}`
  const cache = cacheEtagPedidos.get(chave)

  const headers = new Headers({ Authorization: `Bearer ${conexao.desktopApiKey}` })
  if (cache) headers.set('If-None-Match', cache.etag)

  const response = await fetch(`${conexao.apiBaseUrl}${caminho}`, { headers })

  if (response.status === 304 && cache) return cache.pedidos

  const payload = await response.json().catch(() => null) as { error?: string } | Record<string, unknown>[] | null

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload
      ? String(payload.error)
      : `Servidor respondeu ${response.status}`
    throw new Error(message)
  }

  const pedidos = (payload ?? []) as Record<string, unknown>[]
  const etag = response.headers.get('etag')
  // Sem ETag na resposta (servidor antigo, ou algo mudou de contrato): não
  // guarda nada, pra nunca arriscar mandar um If-None-Match que compare contra
  // o corpo errado.
  if (etag) cacheEtagPedidos.set(chave, { etag, pedidos })
  else cacheEtagPedidos.delete(chave)

  return pedidos
}

/**
 * Busca em TODAS as lojas ligadas e junta o resultado.
 *
 * Cada pedido sai daqui carregando de qual conexão veio. Sem isso, apertar
 * "em preparo" num pedido da segunda loja mandaria a mudança para o servidor
 * da primeira — que responderia "pedido não encontrado", ou pior, encontraria
 * outro pedido com o mesmo id.
 *
 * `allSettled` e não `all`: uma loja fora do ar não pode esconder os pedidos da
 * outra. A cozinha continua trabalhando com o que dá para ver. `conexoesOk`
 * diz QUAIS responderam desta vez — o vigia de pedidos novos precisa disso
 * para não tratar uma loja que só piscou offline como se tivesse perdido todo
 * o histórico dela (ver o comentário em pedidosVistosMain).
 */
async function buscarComStatusPorConexao(caminho: string): Promise<BuscaResultado> {
  const conexoes = getConnections()
  if (conexoes.length === 0) throw new Error('Configure a URL e o código da loja')

  // A etiqueta só faz sentido com mais de uma loja: com uma, ela apareceria
  // idêntica em todo cartão sem informar nada.
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

  const juntos: Record<string, unknown>[] = []
  const conexoesOk = new Set<string>()
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      juntos.push(...(r.value as Record<string, unknown>[]))
      conexoesOk.add(conexoes[i].id)
    } else {
      console.error(`Loja ${conexoes[i].label || conexoes[i].id} indisponível:`, r.reason)
    }
  })

  // DEDUPE POR ID DO PEDIDO.
  //
  // A mesma loja pode ser alcançada por DUAS conexões nesta máquina: desde que
  // uma loja passou a poder ter vários aparelhos, dá para gerar dois códigos da
  // mesma loja e ligar os dois aqui. `adicionarConexao` só barra o par
  // (url, token) idêntico — dois tokens diferentes da mesma loja passam.
  //
  // Sem isto o pedido vinha duas vezes: dois cartões na tela, DUAS COMANDAS
  // impressas e o som tocando em dobro. O id do pedido é um uuid e é único
  // entre lojas, então id repetido só pode ser o mesmo pedido visto duas vezes.
  // Fica a primeira ocorrência — a conexão que respondeu primeiro é a que o
  // cartão vai usar para agir sobre o pedido.
  const vistos = new Set<string>()
  const unicos = juntos.filter((pedido) => {
    const id = String(pedido.id ?? '')
    if (!id || vistos.has(id)) return false
    vistos.add(id)
    return true
  })

  // TODAS falharam (rede/servidor fora no boot) → ERRO, não lista vazia. Uma
  // lista vazia aqui faria o renderer marcar "primeira carga feita" com zero
  // pedidos conhecidos; a carga seguinte, bem-sucedida, trataria todo pedido de
  // ontem como novo e reimprimiria tudo.
  if (resultados.length > 0 && resultados.every((r) => r.status === 'rejected')) {
    throw new Error('Nenhuma loja respondeu')
  }

  // Ordena por chegada, misturando as lojas. Quem está no balcão reage ao
  // pedido que chegou, não à loja de onde ele veio.
  const pedidosOrdenados = unicos.sort((a, b) => {
    const da = String(a.created_at ?? '')
    const db = String(b.created_at ?? '')
    return db.localeCompare(da)
  })

  return { pedidos: pedidosOrdenados, conexoesOk }
}

/** Só a lista, para quem não precisa saber quais conexões responderam. */
async function buscarEmTodasAsLojas(caminho: string): Promise<unknown[]> {
  return (await buscarComStatusPorConexao(caminho)).pedidos
}

ipcMain.handle('fetch-orders', async () => {
  return buscarEmTodasAsLojas('/api/desktop/orders')
})

// ── Vigia de pedidos novos NO PROCESSO PRINCIPAL ─────────────────────────
// A janela fica minimizada / na bandeja o dia todo, e o Chromium estrangula o
// timer do renderer nesse estado. O processo principal nunca dorme — é ELE que
// garante a impressão da comanda e a notificação de pedido novo. O renderer só
// toca o som e mostra o toast, avisado por IPC.
//
// Os vistos são por CONEXÃO, não um Set único: `Promise.allSettled` já aceita
// que uma loja fique fora do ar sem derrubar as outras, mas um Set único
// apagava TUDO a cada ciclo (`.clear()`) — inclusive o que já sabíamos da loja
// que só piscou. Quando ela voltava, todo pedido dela na janela de 24h virava
// "novo" de novo: reimpressão e som em dobro por uma queda de rede de segundos.
const pedidosVistosMain = new Map<string, Set<string>>()
let primeiraVarreduraMain = true
const NOVO_PEDIDO_RECENTE_MS = 20 * 60 * 1000

// ── Ritmo do vigia ────────────────────────────────────────────────────────
// Rápido (7s) enquanto há movimento; devagar (25s) depois de um tempo sem
// pedido novo — loja fechada ou de madrugada não precisa da mesma frequência
// do horário de pico. Corta pela metade as requisições do balcão pro servidor
// nesses períodos. Trade-off aceito: um pedido que chegar bem no início de uma
// janela ociosa pode demorar até ~18s a mais que hoje para acender o alarme da
// cozinha, no pior caso — só nesse período, nunca durante movimento.
let vigiaEmAndamento = false
let ultimoPedidoNovoEm = Date.now()
let timerVigia: ReturnType<typeof setTimeout> | null = null
const INTERVALO_ATIVO_MS = 7_000
const INTERVALO_OCIOSO_MS = 25_000
const JANELA_ATIVIDADE_MS = 10 * 60 * 1000

function agendarVigiaDePedidos() {
  if (timerVigia) clearTimeout(timerVigia)
  const ocioso = Date.now() - ultimoPedidoNovoEm > JANELA_ATIVIDADE_MS
  timerVigia = setTimeout(async () => {
    // Não empilha: se o ciclo anterior ainda não terminou (servidor lento),
    // este tick só reagenda — evita duas buscas da mesma loja em voo ao
    // mesmo tempo.
    if (!vigiaEmAndamento) {
      vigiaEmAndamento = true
      try {
        await vigiarPedidosNovos()
      } finally {
        vigiaEmAndamento = false
      }
    }
    agendarVigiaDePedidos()
  }, ocioso ? INTERVALO_OCIOSO_MS : INTERVALO_ATIVO_MS)
}

// Espelha ehMarketplace() de src/types.ts — duplicado de propósito: o build do
// electron-vite separa processo principal de renderer, e o projeto já mantém
// utilitários puros assim duplicados entre os dois (ver orderFlow.ts).
function ehMarketplace(channel: string): boolean {
  return channel === 'ifood' || channel === '99food'
}

function deveImprimirCanal(channel: string, filtro: string): boolean {
  if (filtro === 'ifood') return ehMarketplace(channel)
  if (filtro === 'own') return !ehMarketplace(channel)
  return true
}

async function vigiarPedidosNovos() {
  let resultado: BuscaResultado
  try {
    resultado = await buscarComStatusPorConexao('/api/desktop/orders')
  } catch {
    return // rede/servidor fora — tenta no próximo ciclo, sem consumir a 1ª varredura
  }
  const pedidos = resultado.pedidos

  const operacionais = pedidos.filter((p) => p.status !== 'awaiting_payment')
  const novos = primeiraVarreduraMain
    ? []
    : operacionais.filter((p) => {
        const vistosDaConexao = pedidosVistosMain.get(String(p.connectionId ?? ''))
        return !vistosDaConexao?.has(p.id as string)
      })

  // Só reconstrói o "visto" das conexões que responderam AGORA — a de quem
  // ficou fora do ar neste ciclo mantém o que já sabíamos dela.
  for (const connId of resultado.conexoesOk) pedidosVistosMain.set(connId, new Set())
  for (const p of operacionais) {
    pedidosVistosMain.get(String(p.connectionId ?? ''))?.add(p.id as string)
  }
  primeiraVarreduraMain = false

  // Empurra a lista pronta pro renderer — ele não busca mais sozinho. Antes o
  // processo principal e o renderer chamavam /api/desktop/orders CADA UM por
  // conta própria a cada 7s: o dobro de requisições por nada, já que os dois
  // queriam exatamente a mesma coisa. Manda mesmo sem pedido novo — é o que
  // mantém a cor de urgência do cartão e o estágio do entregador do iFood
  // atualizados na tela.
  mainWindow?.webContents.send('pedidos-atualizados', operacionais)

  if (novos.length === 0) return

  ultimoPedidoNovoEm = Date.now()

  const cfg = loadConfig()
  const autoPrint = cfg.autoPrint !== 'false'
  const canais = cfg.autoPrintChannels || 'all'
  const widthCols = cfg.printerWidth === '80' ? 48 : 32
  const vias = Number(normalizarVias(cfg.printCopies))

  for (const p of novos) {
    // Um pedido que só "apareceu" na lista mas é de horas atrás não é novo.
    if (Date.now() - new Date(p.created_at as string).getTime() > NOVO_PEDIDO_RECENTE_MS) continue

    const canal = String(p.channel ?? 'web')
    const origem = canal === 'ifood' ? ' iFood'
      : canal === '99food' ? ' 99Food'
      : canal === 'whatsapp' ? ' WhatsApp'
      : ''
    const isPickup = p.fulfillment_type === 'pickup'

    // Notificação nativa do SO — só quando a janela NÃO está em foco (minimizada,
    // na bandeja ou atrás de outra). Com a janela à frente, o toast + som do
    // renderer já cobrem, e a notificação do SO seria barulho duplicado. Deixo
    // `silent: false` para haver som garantido mesmo se o áudio do renderer
    // estiver suspenso pelo SO nesse estado.
    const janelaEmFoco = mainWindow?.isFocused() ?? false
    if (!janelaEmFoco) {
      try {
        new Notification({
          title: `${isPickup ? 'RETIRADA — ' : ''}Novo pedido${origem}`,
          body: `#${orderLabel(p as never)} — ${String(p.customer_name ?? '')}`,
          silent: false,
        }).show()
      } catch { /* ignore */ }
    }

    // Impressão — o processo principal é o dono; o renderer não imprime mais.
    if (autoPrint && cfg.printerName && deveImprimirCanal(canal, canais)) {
      try {
        await autoPrintOrder(p, cfg.printerName, widthCols, vias)
      } catch (err) {
        console.error('Falha ao imprimir pedido novo (vigia principal):', err)
      }
    }

    // Avisa o renderer para o alerta sonoro + toast na tela.
    mainWindow?.webContents.send('novo-pedido', {
      id: p.id,
      label: orderLabel(p as never),
      canal,
      customerName: p.customer_name,
      isPickup,
    })
  }
}

/**
 * Histórico paginado, por CONEXÃO — não um offset só compartilhado.
 *
 * O jeito antigo mandava o MESMO offset pras duas lojas e devolvia tudo sem
 * cortar: com duas lojas ligadas, uma "página" de 30 virava até 60 linhas, e
 * `hasMore` (que só olhava `fetched.length === 30`) quase nunca batia — o
 * botão "carregar mais" sumia cedo demais. Aqui cada conexão pede a partir de
 * QUANTAS LINHAS DELA já apareceram na tela (o renderer manda isso, contado do
 * que já tem em `historyOrders`), e a mescla corta pro tamanho pedido — o que
 * sobra da mescla não se perde, só aparece na página seguinte.
 */
ipcMain.handle('fetch-order-history', async (
  _e,
  opts: { limit: number; offsetsPorConexao?: Record<string, number>; status?: string }
) => {
  const conexoes = getConnections()
  const etiquetar = conexoes.length > 1
  const offsets = opts.offsetsPorConexao ?? {}

  const resultados = await Promise.allSettled(
    conexoes.map(async (conexao) => {
      const offset = offsets[conexao.id] ?? 0
      const params = new URLSearchParams({ history: 'true', limit: String(opts.limit), offset: String(offset) })
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
  const juntos: Record<string, unknown>[] = []
  for (const r of resultados) {
    if (r.status !== 'fulfilled') continue
    totalAntesDoCorte += r.value.length
    if (r.value.length === opts.limit) algumaPaginaCheia = true
    juntos.push(...r.value)
  }

  const ordenados = juntos.sort((a, b) => {
    const da = String(a.created_at ?? '')
    const db = String(b.created_at ?? '')
    return db.localeCompare(da)
  })

  return {
    orders: ordenados.slice(0, opts.limit),
    // A mesma folga que a versão de uma loja já usava (>= um lote cheio pode
    // ter mais) — só que agora também considera o que a mescla cortou.
    hasMore: totalAntesDoCorte > opts.limit || algumaPaginaCheia,
  }
})

ipcMain.handle('update-order-status', async (_e, orderId: string, status: string, connectionId?: string) => {
  try {
    // Pedido do iFood responde `{ requested: true }` — pedimos ao iFood, o card
    // só anda quando o evento voltar. Pedido próprio responde `{ success: true }`.
    const data = await desktopRequest<{ requested?: boolean; message?: string }>(
      `/api/desktop/orders/${encodeURIComponent(orderId)}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      connectionId
    )
    return { ok: true, requested: Boolean(data?.requested), message: data?.message ?? null }
  } catch (error) {
    console.error('Erro ao atualizar pedido:', error)
    return { ok: false, error: error instanceof Error ? error.message : 'Erro ao atualizar o pedido' }
  }
})

ipcMain.handle('get-ifood-cancel-reasons', async (_e, orderId: string, connectionId?: string) => {
  try {
    const data = await desktopRequest<{ reasons: { code: string; description: string }[] }>(
      `/api/desktop/orders/${encodeURIComponent(orderId)}/cancelar`,
      {},
      connectionId
    )
    return { ok: true, reasons: data.reasons ?? [] }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Erro ao carregar motivos' }
  }
})

ipcMain.handle('request-ifood-cancel', async (_e, orderId: string, code: string, description: string, connectionId?: string) => {
  try {
    await desktopRequest(`/api/desktop/orders/${encodeURIComponent(orderId)}/cancelar`, {
      method: 'POST',
      body: JSON.stringify({ code, description }),
    }, connectionId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'O iFood recusou o cancelamento' }
  }
})

ipcMain.handle('get-store-pause-state', async (_e, connectionId?: string) => {
  try {
    return { ok: true, ...(await desktopRequest('/api/desktop/pausa', {}, connectionId) as object) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Erro ao consultar a loja' }
  }
})

ipcMain.handle('set-store-pause', async (_e, body: Record<string, unknown>, connectionId?: string) => {
  try {
    await desktopRequest('/api/desktop/pausa', { method: 'POST', body: JSON.stringify(body) }, connectionId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Não foi possível concluir' }
  }
})

// ── Disputas do iFood (Plataforma de Negociação) ─────────────────────────
ipcMain.handle('get-ifood-disputes', async () => {
  const conexoes = getConnections()
  const etiquetar = conexoes.length > 1
  const resultados = await Promise.allSettled(
    conexoes.map(async (c) => {
      const r = await desktopRequest<{ disputas: Record<string, unknown>[] }>('/api/desktop/ifood/disputas', {}, c.id)
      return (r.disputas ?? []).map((d) => ({
        ...d,
        connectionId: c.id,
        storeLabel: etiquetar ? c.label || 'Loja' : '',
      }))
    })
  )
  const disputas: unknown[] = []
  resultados.forEach((r) => { if (r.status === 'fulfilled') disputas.push(...r.value) })
  return { disputas }
})

ipcMain.handle('respond-ifood-dispute', async (_e, disputeId: string, resposta: 'accept' | 'reject', motivo: string | null, connectionId?: string) => {
  try {
    await desktopRequest('/api/desktop/ifood/disputas', {
      method: 'POST',
      body: JSON.stringify({ disputeId, resposta, motivo }),
    }, connectionId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Não foi possível responder a disputa' }
  }
})

ipcMain.handle('acknowledge-order', async (_e, orderId: string, connectionId?: string) => {
  try {
    await desktopRequest(`/api/desktop/orders/${encodeURIComponent(orderId)}/acknowledge`, {
      method: 'POST',
    }, connectionId)
    return true
  } catch (error) {
    console.error('Erro ao reconhecer pedido:', error)
    return false
  }
})

// A moldura é desenhada pelo renderer, mas o controle da janela continua no
// processo principal. Assim o React não ganha acesso a APIs nativas amplas.
ipcMain.handle('window-minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window-toggle-maximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})

ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false)

ipcMain.handle('window-close', () => {
  mainWindow?.close()
})

// ── WhatsApp (chat com clientes, espelha o painel do admin na web) ─────────
/**
 * Quais lojas este computador atende.
 *
 * Pergunta a cada servidor quem ele é e GUARDA o nome na conexão. O nome vem do
 * servidor, e não do que o lojista digitou, porque é ele que aparece na
 * etiqueta de cada pedido — um apelido local divergiria do painel e faria a
 * cozinha duvidar de qual loja é qual.
 */
ipcMain.handle('get-stores', async () => {
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

  const registros = readConnections()
  const resultado = conexoes.map((c, i) => {
    const r = nomes[i]
    const nome = r.status === 'fulfilled' ? r.value.storeName : null
    if (nome) {
      const registro = registros.find((x) => x.id === c.id)
      if (registro) registro.label = nome
    }
    return {
      id: c.id,
      // Servidor fora do ar mantém o último nome conhecido: apagar a etiqueta
      // deixaria os pedidos daquela loja sem identificação na tela.
      storeName: nome ?? c.label ?? null,
      online: r.status === 'fulfilled',
      ifoodConectado: r.status === 'fulfilled' ? Boolean(r.value.ifoodConectado) : false,
      ifoodPollingParadoSegundos: r.status === 'fulfilled' ? r.value.ifoodPollingParadoSegundos ?? null : null,
    }
  })

  if (registros.length > 0) writeConnections(registros)
  return resultado
})

/**
 * Busca em TODAS as lojas ligadas — o WhatsApp é uma instância própria por
 * loja, igual pedidos e disputas. Antes esta rota só falava com a PRIMEIRA
 * conexão (era o que `desktopRequest` devolve sem `connectionId`): um balcão
 * atendendo duas lojas só via conversa da primeira pelo WhatsApp, e a segunda
 * simplesmente não aparecia.
 */
ipcMain.handle('get-whatsapp-status', async () => {
  const conexoes = getConnections()
  const etiquetar = conexoes.length > 1

  const resultados = await Promise.allSettled(
    conexoes.map(async (c) => {
      const r = await desktopRequest<{ conversations: Record<string, unknown>[]; connectionState: string }>(
        '/api/desktop/whatsapp/status', {}, c.id
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

  const conversations: Record<string, unknown>[] = []
  const connectionStates: { connectionId: string; storeLabel: string; state: string }[] = []
  for (const r of resultados) {
    // Falha nesta conexão fica de fora, sem marcar como "desconectada" — pode
    // ser só o servidor daquela loja fora do ar por um instante, e não o
    // WhatsApp em si; `stores` (get-stores) já cobre "loja fora do ar".
    if (r.status !== 'fulfilled') continue
    conversations.push(...r.value.conversations)
    connectionStates.push({ connectionId: r.value.connectionId, storeLabel: r.value.storeLabel, state: r.value.connectionState })
  }

  conversations.sort((a, b) => {
    const da = String(a.updatedAt ?? '')
    const db = String(b.updatedAt ?? '')
    return db.localeCompare(da)
  })

  return { conversations, connectionStates }
})

ipcMain.handle('get-whatsapp-messages', async (_e, conversationId: string, connectionId?: string) => {
  return desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`, {}, connectionId)
})

ipcMain.handle('send-whatsapp-reply', async (_e, conversationId: string, message: string, connectionId?: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  }, connectionId)
  return true
})

ipcMain.handle('resume-whatsapp-bot', async (_e, conversationId: string, connectionId?: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/resume-bot`, {
    method: 'POST',
  }, connectionId)
  return true
})

ipcMain.handle('mark-whatsapp-conversation-seen', async (_e, conversationId: string, connectionId?: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/seen`, {
    method: 'POST',
  }, connectionId)
  return true
})

// ── Uma instância só ──────────────────────────────────────────────────────
/**
 * Sem esta trava o Cardapia abria DUAS VEZES — e o defeito só aparecia na
 * impressora.
 *
 * Fechar a janela não encerra o programa: ele se esconde na bandeja (ver
 * `window-all-closed`). Para quem está no balcão, "fechei o Cardapia" e
 * "cliquei no atalho de novo" é o gesto mais natural do mundo — e criava um
 * segundo processo inteiro, com bandeja, polling de 7 em 7 segundos e
 * impressora próprios. Resultado: DUAS comandas idênticas por pedido, som em
 * dobro, e nada na tela dizendo o que estava acontecendo.
 *
 * Agora a segunda cópia não sobe: ela devolve o foco para a que já está
 * rodando e sai. `exit(0)` e não `quit()` — `quit()` dispararia os ganchos de
 * ciclo de vida desta cópia natimorta, e um deles é o que esconde na bandeja.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Marca o inicio de cada sessao: sem isto, o log e uma lista de falhas sem
  // saber qual versao rodava nem onde uma execucao termina e outra comeca.
  registrar('info', `Cardapia ${app.getVersion()} iniciou`)

  // Sobe o host de impressão cedo — a primeira comanda do dia não deveria
  // pagar o custo de compilar a classe RawPrinter (ver escpos.ts).
  prewarmHostImpressao()

  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: 'Cardapia — Pedidos',
    frame: false,
    backgroundColor: '#FAFAF8',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A cozinha minimiza / manda o app pra bandeja o dia todo. Sem isto, o
      // Chromium estrangula os timers do renderer quando a janela não está
      // visível, e o polling de pedidos novos praticamente para.
      backgroundThrottling: false,
      // Deixa o alerta sonoro tocar mesmo com a janela escondida.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  const sendWindowMaximizedState = () => {
    mainWindow?.webContents.send('window-maximized-changed', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendWindowMaximizedState)
  mainWindow.on('unmaximize', sendWindowMaximizedState)

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  // System tray
  tray = new Tray(loadTrayIcon())
  tray.setToolTip('Cardapia')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => mainWindow?.show() },
    { label: 'Verificar atualização', click: () => checkForUpdates(true) },
    // Como o motivo tecnico da falha de impressao deixou de aparecer na tela,
    // precisa existir um jeito de chegar nele sem ditar caminho de pasta por
    // telefone.
    { label: 'Abrir pasta de logs', click: () => { void shell.openPath(pastaDoLog()) } },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', () => mainWindow?.show())

  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
  })

  // Checa ao abrir (com um respiro pra não brigar com o carregamento inicial)
  // e depois periodicamente — o app costuma ficar aberto o dia inteiro.
  if (app.isPackaged) {
    setTimeout(checkForUpdates, 5000)
    setInterval(checkForUpdates, 4 * 60 * 60 * 1000)
  }

  // Vigia de pedidos novos no processo principal — imprime e notifica mesmo com
  // a janela minimizada / na bandeja. Auto-agendado (ver agendarVigiaDePedidos):
  // o ritmo varia sozinho conforme o movimento.
  setTimeout(() => agendarVigiaDePedidos(), 2000)
})

app.on('before-quit', () => {
  isQuitting = true
  encerrarHostImpressao()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
