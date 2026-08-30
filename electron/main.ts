import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, dialog, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { buildReceiptEscPos, printRawEscPos } from './escpos'
import { orderLabel, origemLabel } from './receiptFormat'

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
function adicionarConexao(apiBaseUrl: string, desktopApiKey: string): { erro?: string } {
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
  encodeKey(registro, token)
  lista.push(registro)
  writeConnections(lista)
  return {}
}

function removerConexao(id: string) {
  writeConnections(readConnections().filter((c) => c.id !== id))
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
              mainWindow?.webContents.send('print-error', message)
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

// ── Entry point: ESC/POS cru primeiro, HTML como reserva ────────────────
async function autoPrintOrder(order: Record<string, unknown>, printerName: string, widthCols: 32 | 48) {
  try {
    await printRawEscPos(buildReceiptEscPos(order, widthCols), printerName)
  } catch (escposError) {
    console.error('ESC/POS falhou, tentando HTML:', escposError)
    await chromiumPrint(order, printerName, widthCols)
  }
}

function buildReceiptHtml(order: Record<string, unknown>, widthCols: 32 | 48): string {
  // HTML-escape user data to prevent broken markup
  const h = (s: unknown) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const bodyWidthMm = widthCols === 48 ? 72 : 48
  const pageWidthMm = widthCols === 48 ? 80 : 58
  const origem = origemLabel(order.channel as string)
  const isIfood = order.channel === 'ifood'

  const PAYMENT_LABELS: Record<string, string> = {
    pix: 'Pix', cash: 'Dinheiro', credit_card: 'Cr&eacute;dito',
    debit_card: 'D&eacute;bito', meal_voucher: 'Vale Ref.', food_voucher: 'Vale Alim.',
    ifood_online: 'Pago no iFood', card_on_delivery: 'Cart&atilde;o na entrega',
  }

  const ep = (order.external_payload ?? null) as {
    createdAt?: string
    merchant?: { name?: string }
    customer?: { ordersCountOnMerchant?: number }
    total?: { orderAmount?: number; benefits?: number }
  } | null
  const nomeLoja = h(ep?.merchant?.name || order.store_name || '')
  const nPedidosCliente = typeof ep?.customer?.ordersCountOnMerchant === 'number' ? ep.customer.ordersCountOnMerchant : null

  const date = new Date(((isIfood && ep?.createdAt) || order.created_at) as string).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })

  const R = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const Rf = (reais: number) => Number(reais).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  const items = (order.order_items as Record<string, unknown>[]) || []
  const isPickup = order.fulfillment_type === 'pickup'
  const itemsHtml = items.map((item: Record<string, unknown>) => {
    const addons = ((item.addon_selections as { groupName: string; selectedOptions: { name: string }[] }[]) || [])
      .map(a => `<tr><td colspan="2" class="sm" style="padding-left:2mm">+ ${a.selectedOptions.map(o => h(o.name)).join(', ')}</td></tr>`)
      .join('')
    return `<tr>
      <td>${item.quantity}x ${h(item.product_name)}</td>
      <td class="r">${R(item.subtotal_cents as number)}</td>
    </tr>${addons}`
  }).join('')

  const sep = `<tr><td colspan="2"><div style="border-top:1px dashed #000;margin:2mm 0"></div></td></tr>`

  const addrLine = h(order.address) + ', ' + h(order.address_number) +
    (order.address_complement ? ', ' + h(order.address_complement) : '')
  const cityLine = (order.neighborhood ? h(order.neighborhood) + ' &mdash; ' : '') +
    h(order.city) + '/' + h(order.state)
  const pickupAddress = String(order.pickup_address ?? '').trim()
  const destinationHtml = isPickup
    ? `<div class="pickup">RETIRADA</div><p class="sm bold">Retirar em:</p><p class="sm">${h(pickupAddress || 'Endereço a confirmar com a loja')}</p>`
    : `<p class="sm">${addrLine}</p><p class="sm">${cityLine}</p>`

  const pickupCodeHtml = order.channel === 'ifood' && order.ifood_pickup_code
    ? `<p class="bold sm">Codigo de coleta: ${h(order.ifood_pickup_code)}</p>`
    : ''

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: ${pageWidthMm}mm auto; margin: 0; }
  html, body {
    /* Largura do corpo deixa ~5mm de folga de cada lado da bobina, sem
       desperdiçar papel. */
    width: ${bodyWidthMm}mm;
    margin: 0 auto;
    font-family: 'Courier New', Courier, monospace;
    font-size: 8.5pt;
    color: #000;
    line-height: 1.45;
  }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0; }
  td.r { text-align: right; white-space: nowrap; padding-left: 2mm; }
  .center { text-align: center; }
  .big    { font-size: 11pt; font-weight: bold; }
  .bold   { font-weight: bold; }
  .sm     { font-size: 7.5pt; }
  .sep    { border-top: 1px dashed #000; margin: 2mm 0; }
  .pickup { background:#000; color:#fff; font-size:12pt; font-weight:bold; letter-spacing:1px; padding:1.5mm 0; text-align:center; margin-bottom:2mm; }
  .whatsapp { background:#000; color:#fff; font-size:8pt; font-weight:bold; letter-spacing:1px; padding:1mm 0; text-align:center; margin-bottom:2mm; }
</style>
</head><body>

<p class="center bold" style="font-size:10pt;letter-spacing:1px;margin-bottom:1mm">*** COMANDA ***</p>
${nomeLoja ? `<p class="center bold">${nomeLoja}</p>` : ''}
<p class="center sm">Pedido: ${date}</p>
<p class="whatsapp">${origem}</p>
<hr class="sep">

<p class="big">#${h(orderLabel(order as never))}</p>
${pickupCodeHtml}
<p class="bold" style="font-size:10pt">${h(order.customer_name)}</p>
<p class="sm">${h(order.customer_phone)}</p>
${nPedidosCliente !== null ? `<p class="sm${nPedidosCliente <= 0 ? ' bold' : ''}">${nPedidosCliente <= 0 ? 'Cliente novo na loja' : `Cliente: ${nPedidosCliente} pedido${nPedidosCliente === 1 ? '' : 's'} na loja`}</p>` : ''}

<hr class="sep">

${destinationHtml}

<hr class="sep">

<table>
${itemsHtml}
${sep}
<tr><td class="sm">Subtotal</td><td class="r sm">${R(order.subtotal_cents as number)}</td></tr>
<tr><td class="sm">${isPickup ? 'Retirada' : 'Entrega'}</td><td class="r sm">${R(order.delivery_fee_cents as number)}</td></tr>
${sep}
<tr><td class="bold" style="font-size:9.5pt">TOTAL</td><td class="r bold" style="font-size:9.5pt">${R(order.total_cents as number)}</td></tr>
${isIfood && typeof ep?.total?.benefits === 'number' && ep.total.benefits > 0
  ? `<tr><td class="sm">Desconto iFood</td><td class="r sm">-${Rf(ep.total.benefits)}</td></tr>` : ''}
${isIfood && typeof ep?.total?.orderAmount === 'number'
  ? `<tr><td class="bold sm">Cliente pagou</td><td class="r bold sm">${Rf(ep.total.orderAmount)}</td></tr>` : ''}
</table>

<hr class="sep">

<p class="bold">Pagto: ${PAYMENT_LABELS[order.payment_method as string] || h(order.payment_method)}</p>
${order.change_for_cents ? `<p class="sm">Troco para: ${R(order.change_for_cents as number)}</p>` : ''}
${order.notes ? `<hr class="sep"><p class="bold">Obs:</p><p class="sm">${h(order.notes)}</p>` : ''}

<hr class="sep">
<p class="center sm">Obrigado pela preferencia!</p>

</body></html>`
}

// ── IPC Handlers ──────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => getConfigView())

ipcMain.handle('add-connection', (_e, apiBaseUrl: string, desktopApiKey: string) => {
  return adicionarConexao(apiBaseUrl, desktopApiKey)
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
    await autoPrintOrder(order, cfg.printerName, widthCols)
    return 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao imprimir'
    mainWindow?.webContents.send('print-error', message)
    return 'error'
  }
})

/**
 * Busca em TODAS as lojas ligadas e junta o resultado.
 *
 * Cada pedido sai daqui carregando de qual conexão veio. Sem isso, apertar
 * "em preparo" num pedido da segunda loja mandaria a mudança para o servidor
 * da primeira — que responderia "pedido não encontrado", ou pior, encontraria
 * outro pedido com o mesmo id.
 *
 * `allSettled` e não `all`: uma loja fora do ar não pode esconder os pedidos da
 * outra. A cozinha continua trabalhando com o que dá para ver.
 */
async function buscarEmTodasAsLojas(caminho: string): Promise<unknown[]> {
  const conexoes = getConnections()
  if (conexoes.length === 0) throw new Error('Configure a URL e o código da loja')

  // A etiqueta só faz sentido com mais de uma loja: com uma, ela apareceria
  // idêntica em todo cartão sem informar nada.
  const etiquetar = conexoes.length > 1

  const resultados = await Promise.allSettled(
    conexoes.map(async (conexao) => {
      const pedidos = await desktopRequest<Record<string, unknown>[]>(caminho, {}, conexao.id)
      return pedidos.map((pedido) => ({
        ...pedido,
        connectionId: conexao.id,
        storeLabel: etiquetar ? conexao.label || 'Loja' : '',
      }))
    })
  )

  const juntos: unknown[] = []
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') juntos.push(...r.value)
    else console.error(`Loja ${conexoes[i].label || conexoes[i].id} indisponível:`, r.reason)
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
  return juntos.sort((a, b) => {
    const da = String((a as Record<string, unknown>).created_at ?? '')
    const db = String((b as Record<string, unknown>).created_at ?? '')
    return db.localeCompare(da)
  })
}

ipcMain.handle('fetch-orders', async () => {
  return buscarEmTodasAsLojas('/api/desktop/orders')
})

// ── Vigia de pedidos novos NO PROCESSO PRINCIPAL ─────────────────────────
// A janela fica minimizada / na bandeja o dia todo, e o Chromium estrangula o
// timer do renderer nesse estado. O processo principal nunca dorme — é ELE que
// garante a impressão da comanda e a notificação de pedido novo. O renderer só
// toca o som e mostra o toast, avisado por IPC.
const pedidosVistosMain = new Set<string>()
let primeiraVarreduraMain = true
const NOVO_PEDIDO_RECENTE_MS = 20 * 60 * 1000

function deveImprimirCanal(channel: string, filtro: string): boolean {
  if (filtro === 'ifood') return channel === 'ifood'
  if (filtro === 'own') return channel !== 'ifood'
  return true
}

async function vigiarPedidosNovos() {
  let pedidos: Record<string, unknown>[]
  try {
    pedidos = (await buscarEmTodasAsLojas('/api/desktop/orders')) as Record<string, unknown>[]
  } catch {
    return // rede/servidor fora — tenta no próximo ciclo, sem consumir a 1ª varredura
  }

  const operacionais = pedidos.filter((p) => p.status !== 'awaiting_payment')
  const novos = primeiraVarreduraMain
    ? []
    : operacionais.filter((p) => !pedidosVistosMain.has(p.id as string))

  pedidosVistosMain.clear()
  for (const p of operacionais) pedidosVistosMain.add(p.id as string)
  primeiraVarreduraMain = false

  if (novos.length === 0) return

  const cfg = loadConfig()
  const autoPrint = cfg.autoPrint !== 'false'
  const canais = cfg.autoPrintChannels || 'all'
  const widthCols = cfg.printerWidth === '80' ? 48 : 32

  for (const p of novos) {
    // Um pedido que só "apareceu" na lista mas é de horas atrás não é novo.
    if (Date.now() - new Date(p.created_at as string).getTime() > NOVO_PEDIDO_RECENTE_MS) continue

    const canal = String(p.channel ?? 'web')
    const origem = canal === 'ifood' ? ' iFood' : canal === 'whatsapp' ? ' WhatsApp' : ''
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
        await autoPrintOrder(p, cfg.printerName, widthCols)
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

ipcMain.handle('fetch-order-history', async (_e, opts: { limit: number; offset: number; status?: string }) => {
  const params = new URLSearchParams({ history: 'true', limit: String(opts.limit), offset: String(opts.offset) })
  if (opts.status) params.set('status', opts.status)
  return buscarEmTodasAsLojas(`/api/desktop/orders?${params.toString()}`)
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

ipcMain.handle('get-whatsapp-status', async () => {
  return desktopRequest('/api/desktop/whatsapp/status')
})

ipcMain.handle('get-whatsapp-messages', async (_e, conversationId: string) => {
  return desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`)
})

ipcMain.handle('send-whatsapp-reply', async (_e, conversationId: string, message: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  return true
})

ipcMain.handle('resume-whatsapp-bot', async (_e, conversationId: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/resume-bot`, {
    method: 'POST',
  })
  return true
})

ipcMain.handle('mark-whatsapp-conversation-seen', async (_e, conversationId: string) => {
  await desktopRequest(`/api/desktop/whatsapp/conversations/${encodeURIComponent(conversationId)}/seen`, {
    method: 'POST',
  })
  return true
})

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
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
  // a janela minimizada / na bandeja.
  setTimeout(() => void vigiarPedidosNovos(), 2000)
  setInterval(() => void vigiarPedidosNovos(), 7_000)
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
