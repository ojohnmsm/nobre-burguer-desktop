import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { exec } from 'child_process'
import { randomUUID } from 'crypto'

// ── Atualização automática (electron-updater, provider "generic") ─────────
// Nunca baixa nem instala sem perguntar — só confere e avisa. O arquivo
// latest.yml + o instalador ficam no bucket 'desktop-updates' do Supabase
// Storage (scripts/publish-desktop-update.mjs sobe eles a cada release).
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

autoUpdater.on('error', (error) => {
  console.error('Erro ao verificar atualização:', error)
})

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch((error) => {
    console.error('Erro ao checar atualização:', error)
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let printWindow: BrowserWindow | null = null
let isQuitting = false

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

interface DesktopConfigInput {
  apiBaseUrl?: string
  desktopApiKey?: string
  printerName?: string
  autoPrint?: string
  autoStart?: string
}

function getConfigView() {
  const config = loadConfig()
  return {
    apiBaseUrl: config.apiBaseUrl || '',
    desktopApiKeyConfigured: Boolean(readDesktopApiKey(config)),
    printerName: config.printerName || '',
    autoPrint: config.autoPrint || 'true',
    autoStart: config.autoStart || 'true',
  }
}

function saveConfigInput(input: DesktopConfigInput) {
  const current = loadConfig()
  const next: Record<string, string> = {
    ...current,
    apiBaseUrl: input.apiBaseUrl?.trim().replace(/\/+$/, '') || current.apiBaseUrl || '',
    printerName: input.printerName ?? current.printerName ?? '',
    autoPrint: input.autoPrint ?? current.autoPrint ?? 'true',
    autoStart: input.autoStart ?? current.autoStart ?? 'true',
  }

  const suppliedToken = input.desktopApiKey?.trim()
  if (suppliedToken) {
    storeDesktopApiKey(next, suppliedToken)
  } else if (next.desktopApiKey && safeStorage.isEncryptionAvailable()) {
    // Upgrade a legacy plaintext token the next time the configuration is saved.
    storeDesktopApiKey(next, next.desktopApiKey)
  }

  saveConfig(next)
  return next
}

function getDesktopConnection() {
  const config = loadConfig()
  const apiBaseUrl = config.apiBaseUrl?.trim().replace(/\/+$/, '')
  const desktopApiKey = readDesktopApiKey(config)

  if (!apiBaseUrl || !desktopApiKey) return null

  try {
    const parsed = new URL(apiBaseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return { apiBaseUrl, desktopApiKey }
  } catch {
    return null
  }
}

async function desktopRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const connection = getDesktopConnection()
  if (!connection) throw new Error('Configure a URL e o token de integração do servidor')

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

// ── Supabase Realtime subscription ────────────────────────────────────────
// ── ASCII normalizer: strips diacritics so thermal printer never garbles ─
// "João" → "Joao", "Coração" → "Coracao", "Ação" → "Acao"
function ascii(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')                          // decompose: "ã" → "a" + combining-tilde
    .replace(/[̀-ͯ]/g, '')           // drop all combining diacritics
    .replace(/[^\x20-\x7E]/g, '?')            // replace remaining non-ASCII with ?
}

// ── Plain-text receipt — PRIMARY print path ───────────────────────────────
function buildReceiptText(order: Record<string, unknown>): string {
  const W = 32
  const ctr = (s: string) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2))
    return ' '.repeat(pad) + s
  }
  const row = (l: string, r: string) => {
    const maxL = W - r.length - 1
    const lt = l.length > maxL ? l.substring(0, maxL) : l
    return lt + ' '.repeat(Math.max(0, W - lt.length - r.length)) + r
  }
  const R = (cents: number) => 'R$' + (cents / 100).toFixed(2).replace('.', ',')
  const wrap = (value: string) => {
    const words = value.trim().split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let line = ''

    for (const word of words) {
      if (!line || line.length + word.length + 1 <= W) {
        line = line ? `${line} ${word}` : word
      } else {
        lines.push(line)
        line = word
      }
    }

    if (line) lines.push(line)
    return lines
  }
  const PAYMENT: Record<string, string> = {
    pix: 'Pix', cash: 'Dinheiro', credit_card: 'Credito',
    debit_card: 'Debito', meal_voucher: 'Vale Ref.', food_voucher: 'Vale Alim.',
  }
  const date = new Date(order.created_at as string).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
  const items = (order.order_items as Record<string, unknown>[]) || []
  const DIV = '-'.repeat(W)
  const isPickup = order.fulfillment_type === 'pickup'
  const pickupAddress = ascii(order.pickup_address).trim()

  const addrLine = [
    ascii(order.address),
    ascii(order.address_number),
    order.address_complement ? ascii(order.address_complement) : '',
  ].filter(Boolean).join(', ')

  const cityLine = [
    order.neighborhood ? ascii(order.neighborhood) + ' - ' : '',
    ascii(order.city),
    '/',
    ascii(order.state),
  ].join('')

  const destinationLines = isPickup
    ? [ctr('*** RETIRADA ***'), ...wrap(`RETIRAR EM: ${pickupAddress || 'CONFIRMAR COM A LOJA'}`)]
    : [...wrap(addrLine), ...wrap(cityLine)]

  const lines: string[] = [
    ctr('*** COMANDA ***'),
    ctr(date),
    ...(order.channel === 'whatsapp' ? [ctr('=== VIA WHATSAPP ===')] : []),
    DIV,
    `#${(order.id as string).slice(0, 8).toUpperCase()}`,
    ascii(order.customer_name),
    ascii(order.customer_phone),
    DIV,
    ...destinationLines,
    DIV,
    ...items.flatMap((item: Record<string, unknown>) => {
      const addons = ((item.addon_selections as { groupName: string; selectedOptions: { name: string }[] }[]) || [])
        .flatMap(a => a.selectedOptions.map(o => `  + ${ascii(o.name)}`))
      return [
        row(`${item.quantity}x ${ascii(item.product_name)}`, R(item.subtotal_cents as number)),
        ...addons,
      ]
    }),
    DIV,
    row('Subtotal', R(order.subtotal_cents as number)),
    row(isPickup ? 'Retirada' : 'Entrega', R(order.delivery_fee_cents as number)),
    '='.repeat(W),
    row('TOTAL', R(order.total_cents as number)),
    '='.repeat(W),
    `Pagto: ${PAYMENT[order.payment_method as string] || ascii(order.payment_method)}`,
    ...(order.change_for_cents ? [`Troco: ${R(order.change_for_cents as number)}`] : []),
    ...(order.notes ? [DIV, `Obs: ${ascii(order.notes)}`] : []),
    DIV,
    ctr('Obrigado!'),
    '', '', '',   // feed paper forward before tearing
  ]

  return lines.join('\r\n')
}

// ── PRIMARY: PowerShell Out-Printer (direct to Windows print queue) ───────
// This is the most reliable path for thermal printers on Windows because
// it sends plain ASCII text — no Chromium rendering, no font fallback,
// no ESC/POS conflicts from UTF-8 bytes in the GDI print stream.
function printWithPowerShell(text: string, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpTxt = join(app.getPath('temp'), `nobre-ps-receipt-${randomUUID()}.txt`)
    // Write as ASCII — guarantees no high bytes reach the thermal printer driver
    writeFileSync(tmpTxt, Buffer.from(text, 'ascii'))

    // Escape single quotes for PowerShell string literals
    const safeFile    = tmpTxt.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const safePrinter = printerName.replace(/'/g, "''")

    // Read as Latin-1 (ASCII subset) and pipe directly to print queue
    const cmd =
      `powershell -NoProfile -NonInteractive -Command ` +
      `"$t = [IO.File]::ReadAllText('${safeFile}', [Text.Encoding]::ASCII); ` +
      `$t | Out-Printer -Name '${safePrinter}'"`

    exec(cmd, { timeout: 20000 }, (err) => {
      try { unlinkSync(tmpTxt) } catch { /* ignore */ }
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── FALLBACK: Chromium webContents.print (HTML) ───────────────────────────
function chromiumPrint(order: Record<string, unknown>, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (printWindow) { printWindow.destroy(); printWindow = null }

    const tmpFile = join(app.getPath('temp'), `nobre-receipt-${randomUUID()}.html`)
    writeFileSync(tmpFile, buildReceiptHtml(order), 'utf-8')

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
            pageSize: { width: 58000, height: 297000 },
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

// ── Entry point: try PowerShell first, fall back to Chromium ─────────────
async function autoPrintOrder(order: Record<string, unknown>, printerName: string) {
  try {
    await printWithPowerShell(buildReceiptText(order), printerName)
  } catch {
    // PowerShell failed (e.g. Out-Printer not found, access denied) → try HTML
    await chromiumPrint(order, printerName)
  }
}

function buildReceiptHtml(order: Record<string, unknown>): string {
  // HTML-escape user data to prevent broken markup
  const h = (s: unknown) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const PAYMENT_LABELS: Record<string, string> = {
    pix: 'Pix', cash: 'Dinheiro', credit_card: 'Cr&eacute;dito',
    debit_card: 'D&eacute;bito', meal_voucher: 'Vale Ref.', food_voucher: 'Vale Alim.',
  }

  const date = new Date(order.created_at as string).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })

  const R = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

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

  const viaWhatsapp = order.channel === 'whatsapp'

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { margin: 0; }
  html, body {
    /* Página impressa a 58mm (ver pageSize no webContents.print) e sem
       margem — 48mm deixa ~5mm de folga de cada lado, a área impressa
       segura mais comum em bobinas de 58mm, sem desperdiçar papel. */
    width: 48mm;
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
<p class="center sm">${date}</p>
${viaWhatsapp ? '<p class="whatsapp">VIA WHATSAPP</p>' : ''}
<hr class="sep">

<p class="big">#${(order.id as string).slice(0, 8).toUpperCase()}</p>
<p class="bold" style="font-size:10pt">${h(order.customer_name)}</p>
<p class="sm">${h(order.customer_phone)}</p>

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

ipcMain.handle('save-config', (_e, input: DesktopConfigInput) => {
  const config = saveConfigInput(input)
  try {
    app.setLoginItemSettings({ openAtLogin: config.autoStart === 'true', path: app.getPath('exe') })
  } catch { /* ignore — can fail in dev/unpacked builds */ }
  return true
})

ipcMain.handle('get-notification-sounds', async () => {
  try {
    return await desktopRequest<{ orderSoundUrl: string | null; messageSoundUrl: string | null }>('/api/desktop/notification-sounds')
  } catch {
    return { orderSoundUrl: null, messageSoundUrl: null }
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
  try {
    await autoPrintOrder(order, cfg.printerName)
    return 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao imprimir'
    mainWindow?.webContents.send('print-error', message)
    return 'error'
  }
})

ipcMain.handle('fetch-orders', async () => {
  return desktopRequest<unknown[]>('/api/desktop/orders')
})

ipcMain.handle('fetch-order-history', async (_e, opts: { limit: number; offset: number; status?: string }) => {
  const params = new URLSearchParams({ history: 'true', limit: String(opts.limit), offset: String(opts.offset) })
  if (opts.status) params.set('status', opts.status)
  return desktopRequest<unknown[]>(`/api/desktop/orders?${params.toString()}`)
})

ipcMain.handle('update-order-status', async (_e, orderId: string, status: string) => {
  try {
    await desktopRequest(`/api/desktop/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
    return true
  } catch (error) {
    console.error('Erro ao atualizar pedido:', error)
    return false
  }
})

ipcMain.handle('acknowledge-order', async (_e, orderId: string) => {
  try {
    await desktopRequest(`/api/desktop/orders/${encodeURIComponent(orderId)}/acknowledge`, {
      method: 'POST',
    })
    return true
  } catch (error) {
    console.error('Erro ao reconhecer pedido:', error)
    return false
  }
})

// ── WhatsApp (chat com clientes, espelha o painel do admin na web) ─────────
ipcMain.handle('get-store', async () => {
  // Qual loja este computador atende. O cabeçalho mostrava marca chumbada, o
  // que numa plataforma faz o dono de uma loja ler o nome de outra.
  try {
    return await desktopRequest('/api/desktop/loja')
  } catch {
    // Sem servidor configurado ainda, ou fora do ar: o cabeçalho cai na marca
    // da plataforma em vez de deixar a janela sem identidade.
    return { storeName: null }
  }
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
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: 'Cardapia — Pedidos',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  // System tray
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="#f59e0b"/>
      <path d="M15 24h34v5H15zm4 8h26v5H19zm5 8h16v5H24z" fill="#111827"/>
    </svg>
  `)}`)
  tray = new Tray(icon)
  tray.setToolTip('Cardapia')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => mainWindow?.show() },
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
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
