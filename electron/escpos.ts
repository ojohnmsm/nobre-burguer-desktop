import { app } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { orderLabel, origemLabel } from './receiptFormat'
import { registrar } from './log'

/**
 * Impressão térmica por ESC/POS cru, direto no spooler do Windows.
 *
 * O caminho antigo (`Out-Printer` do PowerShell) jogava o texto no driver do
 * Windows, que assume papel A4/Carta numa impressora térmica — daí o fio fino
 * no meio da bobina e o desperdício de 3x papel. ESC/POS RAW ignora o driver:
 * a impressora imprime os bytes como chegam e avança só o que mandamos.
 *
 * Sem dependência nova: o envio é um `Add-Type` de C# fazendo P/Invoke em
 * winspool.drv (OpenPrinter -> StartDocPrinter datatype RAW -> WritePrinter).
 * Padrão consolidado para térmica no Windows.
 */

// ── Normalização ASCII (acento vira lixo em térmica) ─────────────────────────
function ascii(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
}

// ── Bytes de comando ESC/POS ────────────────────────────────────────────────
const ESC = 0x1b
const GS = 0x1d
const CMD = {
  init: Buffer.from([ESC, 0x40]),               // ESC @  — reset
  alignLeft: Buffer.from([ESC, 0x61, 0]),
  alignCenter: Buffer.from([ESC, 0x61, 1]),
  boldOn: Buffer.from([ESC, 0x45, 1]),
  boldOff: Buffer.from([ESC, 0x45, 0]),
  doubleOn: Buffer.from([GS, 0x21, 0x11]),       // GS ! 0x11 — dobro de largura e altura
  doubleOff: Buffer.from([GS, 0x21, 0x00]),
  // avança 4 linhas e corta (GS V 66 0 — corte parcial, o mais comum)
  feedCut: Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, GS, 0x56, 66, 0]),
}

type LineOpts = { center?: boolean; bold?: boolean; double?: boolean }

/**
 * Uma linha da comanda, ainda sem saber como vai ser impressa.
 *
 * Existe porque havia DUAS comandas mantidas em paralelo: esta, em ESC/POS, e
 * uma em HTML no main.ts, usada como reserva quando o ESC/POS falha. Elas
 * divergiram — dinheiro formatado diferente, outro texto de fecho, e, o que
 * importa de verdade, a de HTML nunca imprimia a observacao POR ITEM. O cliente
 * pedia sem cebola e a cozinha nao ficava sabendo, mas so nos dias em que a
 * reserva entrava. Agora o conteudo nasce aqui, uma vez, e cada meio so o
 * desenha.
 */
export interface ReceiptLine extends LineOpts {
  text: string
}

const ln = (text: string, opts: LineOpts = {}): ReceiptLine => ({ text, ...opts })

function line(text: string, opts: LineOpts = {}): Buffer {
  const parts: Buffer[] = [opts.center ? CMD.alignCenter : CMD.alignLeft]
  if (opts.bold) parts.push(CMD.boldOn)
  if (opts.double) parts.push(CMD.doubleOn)
  parts.push(Buffer.from(ascii(text) + '\n', 'latin1'))
  if (opts.double) parts.push(CMD.doubleOff)
  if (opts.bold) parts.push(CMD.boldOff)
  return Buffer.concat(parts)
}

// ── Layout (32 col em 58mm, 48 col em 80mm) ─────────────────────────────────
function layout(width: number) {
  const ctr = (s: string) => {
    const pad = Math.max(0, Math.floor((width - s.length) / 2))
    return ' '.repeat(pad) + s
  }
  const row = (l: string, r: string) => {
    const maxL = width - r.length - 1
    const lt = l.length > maxL ? l.substring(0, maxL) : l
    return lt + ' '.repeat(Math.max(0, width - lt.length - r.length)) + r
  }
  const wrap = (value: string) => {
    const words = ascii(value).trim().split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let cur = ''
    for (const word of words) {
      if (!cur || cur.length + word.length + 1 <= width) cur = cur ? `${cur} ${word}` : word
      else { lines.push(cur); cur = word }
    }
    if (cur) lines.push(cur)
    return lines
  }
  return { ctr, row, wrap, div: '-'.repeat(width), dbl: '='.repeat(width) }
}

const PAYMENT: Record<string, string> = {
  pix: 'Pix', cash: 'Dinheiro', credit_card: 'Credito', debit_card: 'Debito',
  meal_voucher: 'Vale Ref.', food_voucher: 'Vale Alim.', ifood_online: 'Pago no iFood',
}

// Cartao tem dois caminhos: cobrado online (pedido ja pago) ou na maquininha,
// na entrega. Sem esta marca a comanda sai igual nos dois casos e o entregador
// pode sair sem a maquina.
function rotuloPagamento(order: ReceiptOrder): string {
  const base = PAYMENT[order.payment_method as string] || ascii(order.payment_method)
  return order.card_on_delivery ? `${base} (NA ENTREGA)` : base
}

type ReceiptOrder = Record<string, unknown>

interface IfoodPayload {
  createdAt?: string
  merchant?: { name?: string }
  customer?: { ordersCountOnMerchant?: number; segmentation?: string }
  total?: { orderAmount?: number; benefits?: number }
}

export function buildReceiptLines(order: ReceiptOrder, width: 32 | 48 = 32): ReceiptLine[] {
  const { ctr, row, wrap, div, dbl } = layout(width)
  const R = (cents: number) => 'R$' + (Number(cents) / 100).toFixed(2).replace('.', ',')
  /** Reais decimais (o iFood manda assim no total), não centavos. */
  const Rf = (reais: number) => 'R$' + Number(reais).toFixed(2).replace('.', ',')

  const ep = (order.external_payload ?? null) as IfoodPayload | null
  const isIfood = order.channel === 'ifood'
  // Data/hora: no iFood, quando o pedido foi feito de verdade (createdAt do
  // payload), não quando nós ingerimos.
  const dataPedido = (isIfood && ep?.createdAt) || (order.created_at as string)
  const date = new Date(dataPedido).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const nomeLoja = ascii(ep?.merchant?.name || order.store_name || '').trim()
  const nPedidosCliente = typeof ep?.customer?.ordersCountOnMerchant === 'number'
    ? ep.customer.ordersCountOnMerchant
    : null

  const items = (order.order_items as Record<string, unknown>[]) || []
  const isPickup = order.fulfillment_type === 'pickup'
  const pickupAddress = ascii(order.pickup_address).trim()

  const addrLine = [
    ascii(order.address), ascii(order.address_number),
    order.address_complement ? ascii(order.address_complement) : '',
  ].filter(Boolean).join(', ')
  const cityLine = [
    order.neighborhood ? ascii(order.neighborhood) + ' - ' : '',
    ascii(order.city), order.state ? '/' + ascii(order.state) : '',
  ].join('')

  const out: ReceiptLine[] = []

  out.push(ln('*** COMANDA ***', { center: true, bold: true }))
  if (nomeLoja) out.push(ln(nomeLoja, { center: true, bold: true }))
  out.push(ln(`Pedido: ${date}`, { center: true }))
  out.push(ln(`--- ${origemLabel(order.channel as string)} ---`, { center: true, bold: true }))
  out.push(ln(div))

  // Número do pedido em destaque (dobro de altura).
  out.push(ln(`#${orderLabel(order as never)}`, { bold: true, double: true }))
  if (isIfood && order.ifood_pickup_code) {
    out.push(ln(`Codigo de coleta: ${ascii(order.ifood_pickup_code)}`, { bold: true }))
  }
  out.push(ln(ascii(order.customer_name)))
  out.push(ln(ascii(order.customer_phone)))
  if (nPedidosCliente !== null) {
    out.push(ln(
      nPedidosCliente <= 0
        ? 'Cliente novo na loja'
        : `Cliente: ${nPedidosCliente} pedido${nPedidosCliente === 1 ? '' : 's'} na loja`,
      { bold: nPedidosCliente <= 0 }
    ))
  }
  out.push(ln(div))

  if (isPickup) {
    out.push(ln('*** RETIRADA ***', { center: true, bold: true }))
    for (const l of wrap(`RETIRAR EM: ${pickupAddress || 'CONFIRMAR COM A LOJA'}`)) out.push(ln(l))
  } else {
    for (const l of wrap(addrLine)) out.push(ln(l))
    for (const l of wrap(cityLine)) out.push(ln(l))
  }
  out.push(ln(div))

  for (const item of items) {
    const tam = item.variation_name ? ` ${ascii(item.variation_name as string)}` : ''
    const nomeItem = `${item.quantity}x ${ascii(item.product_name)}${tam}`
    const preco = R(item.subtotal_cents as number)
    if (nomeItem.length + preco.length + 1 <= width) {
      out.push(ln(row(nomeItem, preco)))
    } else {
      // Nome longo: QUEBRA em linhas próprias (não corta) e o preço à direita
      // logo abaixo.
      for (const l of wrap(nomeItem)) out.push(ln(l))
      out.push(ln(row('', preco)))
    }
    const grupos = (item.addon_selections as { selectedOptions: { name: string }[]; pricingRule?: string; groupPriceCents?: number }[]) || []
    for (const g of grupos) {
      if (g.pricingRule && g.pricingRule !== 'sum') {
        // Sabores de pizza: uma linha com os sabores + a regra + o preço.
        const nomes = g.selectedOptions.map((o) => ascii(o.name)).join(' / ')
        const rot = g.pricingRule === 'average' ? 'media' : 'maior'
        for (const l of wrap(`  ${nomes} (${rot})`)) out.push(ln(l))
        out.push(ln(row('', R(g.groupPriceCents ?? 0))))
      } else {
        for (const o of g.selectedOptions) out.push(ln(`  + ${ascii(o.name)}`))
      }
    }
    if (item.notes) out.push(ln(`  obs: ${ascii(item.notes)}`, { bold: true }))
  }

  out.push(ln(div))
  out.push(ln(row('Subtotal', R(order.subtotal_cents as number))))
  out.push(ln(row(isPickup ? 'Retirada' : 'Entrega', R(order.delivery_fee_cents as number))))
  out.push(ln(dbl))
  out.push(ln(row('TOTAL', R(order.total_cents as number)), { bold: true }))
  out.push(ln(dbl))
  // iFood: quanto o cliente efetivamente pagou (com desconto/cupom e taxa do
  // iFood), que é diferente do que a loja recebe (o TOTAL acima).
  if (isIfood && typeof ep?.total?.orderAmount === 'number') {
    if (typeof ep.total.benefits === 'number' && ep.total.benefits > 0) {
      out.push(ln(row('Desconto iFood', '-' + Rf(ep.total.benefits))))
    }
    out.push(ln(row('Cliente pagou', Rf(ep.total.orderAmount)), { bold: true }))
  }
  out.push(ln(`Pagto: ${rotuloPagamento(order)}`, { bold: true }))
  if (order.change_for_cents) out.push(ln(`Troco para: ${R(order.change_for_cents as number)}`))
  if (order.notes) {
    out.push(ln(div))
    out.push(ln('Obs:', { bold: true }))
    for (const l of wrap(String(order.notes))) out.push(ln(l))
  }
  out.push(ln(div))
  out.push(ln('Obrigado!', { center: true }))

  return out
}

/** Desenha as linhas como bytes ESC/POS — o caminho primario. */
export function buildReceiptEscPos(order: ReceiptOrder, width: 32 | 48 = 32): Buffer {
  const partes: Buffer[] = [CMD.init]
  for (const l of buildReceiptLines(order, width)) partes.push(line(l.text, l))
  partes.push(CMD.feedCut)
  return Buffer.concat(partes)
}

/**
 * A reserva: as MESMAS linhas da comanda, desenhadas pelo Chromium.
 *
 * Antes isto era um segundo cupom, com layout, fonte, formato de dinheiro e
 * texto de fecho proprios — e sem a observacao POR ITEM, que simplesmente sumia
 * nos dias em que a reserva entrava. Agora e um <pre> monoespacado sobre
 * `buildReceiptLines`: o que sai por aqui e, caractere por caractere, o que
 * sairia pelo ESC/POS. Cupom diferente confunde quem monta o pedido, e a
 * cozinha nao tem por que saber qual caminho de impressao funcionou hoje.
 */
export function buildReceiptHtml(order: Record<string, unknown>, widthCols: 32 | 48): string {
  const h = (s: unknown) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const pageWidthMm = widthCols === 48 ? 80 : 58

  const linhas = buildReceiptLines(order, widthCols)
    .map((l) => {
      const classes = [
        l.center ? 'c' : '',
        l.bold ? 'b' : '',
        l.double ? 'd' : '',
      ].filter(Boolean).join(' ')
      // Linha vazia precisa de conteudo para ocupar altura no <pre>.
      const texto = h(l.text).length > 0 ? h(l.text) : '&nbsp;'
      return `<span class="${classes}">${texto}</span>`
    })
    .join('')

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: ${pageWidthMm}mm auto; margin: 0; }
  html, body { margin: 0 auto; color: #000; }
  pre {
    /* A largura em unidades ch amarra o texto a mesma grade de colunas do
       ESC/POS — ${widthCols} caracteres exatos — em vez de depender de o
       tamanho em pontos acertar por sorte. */
    width: ${widthCols}ch;
    margin: 0 auto;
    font-family: 'Courier New', Courier, monospace;
    font-size: 9pt;
    line-height: 1.25;
    white-space: pre-wrap;
    word-break: break-word;
  }
  span   { display: block; }
  .c     { text-align: center; }
  .b     { font-weight: bold; }
  .d     { font-size: 15pt; font-weight: bold; line-height: 1.1; }
</style>
</head><body><pre>${linhas}</pre></body></html>`
}

// ── Envio RAW ao spooler ────────────────────────────────────────────────────
// A classe RawPrinter (P/Invoke em winspool.drv, datatype "RAW" — o que pula a
// renderização GDI do driver) é a mesma nos dois caminhos abaixo. O que muda é
// QUANDO ela é compilada.

const RAWPRINTER_CSHARP = `
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = "Comanda Cardapia", pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter falhou");
        int written;
        if (!WritePrinter(h, data, data.Length, out written)) throw new Exception("WritePrinter falhou");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
`.trim()

/** O trabalho confirma o envio escrevendo isto DEPOIS que Send retorna. */
const SENTINELA = 'CARDAPIA_OK'

/**
 * A impressão pode ter saído — e pode não ter. Não dá para tentar de novo.
 *
 * Existe porque a reserva em HTML transformava esta dúvida em DUAS comandas: o
 * `catch` de quem chama caía no Chromium e imprimia por cima de um cupom que
 * talvez já tivesse saído.
 *
 * Quem recebe este erro não deve reimprimir sozinho — deve AVISAR. Uma comanda
 * a menos a pessoa vê no quadro e reimprime pelo cartão; uma a mais é papel
 * jogado fora todo dia, em silêncio.
 */
export class ImpressaoAmbiguaError extends Error {
  constructor(motivo: string) {
    super(`Impressão sem confirmação (${motivo}). Confira o papel e reimprima pelo cartão se não saiu.`)
    this.name = 'ImpressaoAmbiguaError'
  }
}

/** O host não subiu (ou morreu) — nem chegou a tentar imprimir nada. */
class HostIndisponivelError extends Error {}

// ── Host persistente de PowerShell ──────────────────────────────────────────
//
// POR QUE EXISTIR: o caminho de UM TIRO (mantido abaixo como `imprimirAvulso`,
// reserva para quando este host não sobe) abre um `powershell.exe` novo e manda
// `Add-Type` recompilar RawPrinter A CADA COMANDA. Esse compile + o custo de
// abrir o processo era a fatia lenta e variável de toda impressão — a razão do
// tempo-limite de 45s e da classe de erro acima.
//
// Aqui sobe UM processo, uma vez (`prewarmHostImpressao`, chamado no
// app.whenReady), com a classe já carregada; cada comanda depois vira só um
// ReadAllBytes + Send mandado por STDIN a um processo já quente — medido
// localmente em ~15-35ms depois do host pronto, contra os 2-4s do caminho de
// um tiro. A primeira impressão do dia paga o Add-Type (é o próprio prewarm,
// ~1,7s medido); as seguintes não.
//
// O CONTRATO DE printRawEscPos() NÃO MUDA: resolve quando a sentinela do
// TRABALHO confirma, rejeita com ImpressaoAmbiguaError quando o trabalho
// estourou o tempo. Matar o host é a única forma de "cancelar" um comando
// PowerShell em curso — não dá para saber se os bytes já chegaram ao spooler,
// então a dúvida de sempre se aplica, e o host sobe de novo sozinho no próximo
// pedido (ver garantirHost).
type HostProcesso = ReturnType<typeof spawn>

let host: HostProcesso | null = null
let hostPronto: Promise<void> | null = null
let bufferSaida = ''
let filaHost: Promise<unknown> = Promise.resolve()

const HOST_PRONTO = 'CARDAPIA_HOST_PRONTO'
const HOST_ERRO_PREFIXO = 'CARDAPIA_HOST_ERRO:'
const JOB_OK_RE = /^CARDAPIA_JOB_([0-9a-f-]+)_OK$/
const JOB_ERRO_RE = /^CARDAPIA_JOB_([0-9a-f-]+)_ERRO:(.*)$/

const jobsPendentes = new Map<string, { resolve: () => void; reject: (erro: Error) => void }>()

/** Aspas simples dobradas — o jeito do PowerShell escapar dentro de string com aspas simples. */
function escaparPs(valor: string): string {
  return valor.replace(/'/g, "''")
}

const HOST_SCRIPT_INICIAL = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
$code = @"
${RAWPRINTER_CSHARP}
"@
Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
Write-Output "${HOST_PRONTO}"
} catch {
Write-Output "${HOST_ERRO_PREFIXO}$($_.Exception.Message)"
}
`

/** Derruba o host atual (se houver) e rejeita quem ainda esperava resposta dele. */
function derrubarHost(motivo: string) {
  const processoAtual = host
  host = null
  hostPronto = null
  bufferSaida = ''
  if (processoAtual) {
    try { processoAtual.kill() } catch { /* ignore */ }
  }
  for (const job of jobsPendentes.values()) job.reject(new Error(motivo))
  jobsPendentes.clear()
}

function processarLinhaDeTrabalho(linha: string) {
  const ok = linha.match(JOB_OK_RE)
  if (ok) {
    jobsPendentes.get(ok[1])?.resolve()
    jobsPendentes.delete(ok[1])
    return
  }
  const erro = linha.match(JOB_ERRO_RE)
  if (erro) {
    jobsPendentes.get(erro[1])?.reject(new Error(erro[2] || 'Impressão recusada'))
    jobsPendentes.delete(erro[1])
  }
  // Qualquer outra linha (eco, aviso do PowerShell) é ignorada de propósito —
  // só as sentinelas têm significado aqui.
}

/** Sobe o host se preciso, e resolve quando a classe já está carregada. */
function garantirHost(): Promise<HostProcesso> {
  if (host && hostPronto) {
    const processoAtual = host
    return hostPronto.then(() => processoAtual)
  }

  const processo = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true }
  )
  host = processo

  hostPronto = new Promise<void>((resolve, reject) => {
    // 45s: o mesmo custo de sempre — só que agora pago UMA vez por vida do
    // host, não a cada comanda.
    const tempoLimite = setTimeout(() => {
      const erro = new HostIndisponivelError('Tempo esgotado ao iniciar o host de impressão')
      derrubarHost(erro.message)
      reject(erro)
    }, 45000)

    processo.stdout?.on('data', (chunk: Buffer) => {
      bufferSaida += chunk.toString('utf-8')
      let idx: number
      while ((idx = bufferSaida.indexOf('\n')) >= 0) {
        const linha = bufferSaida.slice(0, idx).trim()
        bufferSaida = bufferSaida.slice(idx + 1)
        if (!linha) continue

        if (linha === HOST_PRONTO) {
          clearTimeout(tempoLimite)
          resolve()
          continue
        }
        if (linha.startsWith(HOST_ERRO_PREFIXO)) {
          clearTimeout(tempoLimite)
          const erro = new HostIndisponivelError(linha.slice(HOST_ERRO_PREFIXO.length))
          derrubarHost(erro.message)
          reject(erro)
          continue
        }
        processarLinhaDeTrabalho(linha)
      }
    })

    processo.stderr?.on('data', (chunk: Buffer) => {
      registrar('erro', 'Host de impressão (stderr)', chunk.toString('utf-8').trim())
    })

    processo.on('error', (err) => {
      clearTimeout(tempoLimite)
      const erro = new HostIndisponivelError(err.message)
      derrubarHost(erro.message)
      reject(erro)
    })

    processo.on('exit', (code) => {
      clearTimeout(tempoLimite)
      // Só derruba o estado se ESTE processo ainda for o host atual — evita
      // que a saída de um host já substituído apague o novo.
      if (host === processo) derrubarHost(`Host de impressão encerrou (código ${code})`)
    })

    processo.stdin?.write(HOST_SCRIPT_INICIAL + '\n')
  })

  return hostPronto.then(() => processo)
}

/** Sobe o host cedo (chamado no app.whenReady) — a primeira comanda do dia não paga o Add-Type. */
export function prewarmHostImpressao(): void {
  garantirHost().catch((erro) => {
    registrar(
      'erro',
      'Não foi possível pré-aquecer o host de impressão — a primeira comanda vai usar o processo avulso',
      erro
    )
  })
}

/** Encerra o host, se houver. Chamado no encerramento do app. */
export function encerrarHostImpressao(): void {
  if (host) derrubarHost('App encerrando')
}

/** Um trabalho no host já quente: ReadAllBytes(caminho) + Send(impressora, bytes). */
function executarJobNoHost(processo: HostProcesso, binPath: string, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const jobId = randomUUID()

    // 15s: só o WritePrinter em si, com a classe já carregada — bem menos que
    // o custo de compilar, mas ainda folgado para spooler ou USB lento.
    const tempoLimite = setTimeout(() => {
      jobsPendentes.delete(jobId)
      derrubarHost('Trabalho de impressão sem resposta')
      reject(new ImpressaoAmbiguaError('o host de impressão demorou demais para responder'))
    }, 15000)

    jobsPendentes.set(jobId, {
      resolve: () => { clearTimeout(tempoLimite); resolve() },
      reject: (erro) => { clearTimeout(tempoLimite); reject(erro) },
    })

    const script = `
try {
  $bytes = [System.IO.File]::ReadAllBytes('${escaparPs(binPath)}')
  [RawPrinter]::Send('${escaparPs(printerName)}', $bytes)
  Write-Output "CARDAPIA_JOB_${jobId}_OK"
} catch {
  Write-Output "CARDAPIA_JOB_${jobId}_ERRO:$($_.Exception.Message)"
}
`
    processo.stdin?.write(script + '\n', (err) => {
      if (err) {
        clearTimeout(tempoLimite)
        jobsPendentes.delete(jobId)
        reject(err)
      }
    })
  })
}

async function imprimirComHost(buffer: Buffer, printerName: string): Promise<void> {
  const processo = await garantirHost() // pode rejeitar com HostIndisponivelError

  const tmpBin = join(app.getPath('temp'), `cardapia-escpos-${randomUUID()}.bin`)
  writeFileSync(tmpBin, buffer)

  // Fila simples: nunca dois trabalhos escrevendo no mesmo stdin ao mesmo
  // tempo — a mesma ordem que um humano digitando dois comandos teria, um de
  // cada vez. Uma rejeição não trava a fila para o próximo pedido.
  const executar = () => executarJobNoHost(processo, tmpBin, printerName)
  const tarefa = filaHost.then(executar, executar)
  filaHost = tarefa.then(() => {}, () => {})

  try {
    await tarefa
  } finally {
    try { unlinkSync(tmpBin) } catch { /* ignore */ }
  }
}

// ── Reserva: processo avulso, do zero (só quando o host não sobe) ───────────
const PS_RAW_PRINT_AVULSO = `
param([string]$BinPath, [string]$Printer)
$bytes = [System.IO.File]::ReadAllBytes($BinPath)
$code = @"
${RAWPRINTER_CSHARP}
"@
Add-Type -TypeDefinition $code -Language CSharp
[RawPrinter]::Send($Printer, $bytes)
Write-Output "${SENTINELA}"
`.trim()

function imprimirAvulso(buffer: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpBin = join(app.getPath('temp'), `cardapia-escpos-${randomUUID()}.bin`)
    const tmpPs = join(app.getPath('temp'), `cardapia-rawprint-${randomUUID()}.ps1`)
    try {
      writeFileSync(tmpBin, buffer)
      writeFileSync(tmpPs, PS_RAW_PRINT_AVULSO, 'utf-8')
    } catch (err) {
      reject(err)
      return
    }

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs, '-BinPath', tmpBin, '-Printer', printerName],
      // 45s: o Add-Type compila C# nesta chamada (é a reserva, não o caminho
      // quente), e numa máquina fraca isso é a fatia mais lenta de toda a
      // impressão.
      { timeout: 45000, windowsHide: true },
      (err, stdout) => {
        try { unlinkSync(tmpBin) } catch { /* ignore */ }
        try { unlinkSync(tmpPs) } catch { /* ignore */ }

        // A SENTINELA MANDA, não o código de saída. Ela só é escrita depois de
        // WritePrinter ter retornado, então vê-la significa que o cupom saiu —
        // mesmo que o PowerShell tenha resmungado alguma coisa no fim.
        if (String(stdout ?? '').includes(SENTINELA)) {
          resolve()
          return
        }

        // Morto pelo tempo-limite: os bytes podem ter chegado ao spooler antes
        // da facada. É a dúvida que não pode virar reimpressão automática.
        const morto = Boolean(err && (err as { killed?: boolean }).killed)
        if (morto) {
          reject(new ImpressaoAmbiguaError('o Windows demorou demais para responder'))
          return
        }

        // Saiu sozinho sem a sentinela: falhou de verdade (impressora errada,
        // spooler parado, driver ausente). Aqui a reserva em HTML vale.
        reject(err ?? new Error('ESC/POS terminou sem confirmar o envio'))
      }
    )
  })
}

/**
 * Qual dos dois caminhos de ESC/POS confirmou a última comanda — pro
 * diagnóstico remoto (POST /api/desktop/diagnostico). `null` até a primeira
 * impressão da sessão. Só isto, sem detalhe nenhum de pedido/loja: é
 * telemetria operacional ("esta instalação está no caminho lento"), não log.
 */
let ultimoCaminhoEscpos: 'escpos_host' | 'escpos_avulso' | null = null

export function ultimoCaminhoDeImpressao(): 'escpos_host' | 'escpos_avulso' | null {
  return ultimoCaminhoEscpos
}

/**
 * Ponto de entrada único, igual para quem chama: tenta o host já quente
 * primeiro, cai no processo avulso só se o host não conseguiu nem subir.
 *
 * Erro AMBÍGUO nunca cai no avulso dentro da mesma chamada — é exatamente o
 * que ImpressaoAmbiguaError existe para impedir (ver a classe acima). Um erro
 * de host indisponível, sim: ali nada foi tentado ainda, então tentar pelo
 * caminho antigo é seguro.
 */
export function printRawEscPos(buffer: Buffer, printerName: string): Promise<void> {
  return imprimirComHost(buffer, printerName)
    .then(() => { ultimoCaminhoEscpos = 'escpos_host' })
    .catch((erro) => {
      if (erro instanceof ImpressaoAmbiguaError) throw erro
      if (erro instanceof HostIndisponivelError) {
        registrar('erro', 'Host de impressão indisponível, usando o processo avulso desta vez', erro)
        return imprimirAvulso(buffer, printerName).then(() => { ultimoCaminhoEscpos = 'escpos_avulso' })
      }
      throw erro
    })
}
