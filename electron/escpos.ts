import { app } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { orderLabel, origemLabel } from './receiptFormat'

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
  card_on_delivery: 'Cartao na entrega',
}

type ReceiptOrder = Record<string, unknown>

interface IfoodPayload {
  createdAt?: string
  merchant?: { name?: string }
  customer?: { ordersCountOnMerchant?: number; segmentation?: string }
  total?: { orderAmount?: number; benefits?: number }
}

export function buildReceiptEscPos(order: ReceiptOrder, width: 32 | 48 = 32): Buffer {
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

  const out: Buffer[] = [CMD.init]

  out.push(line('*** COMANDA ***', { center: true, bold: true }))
  if (nomeLoja) out.push(line(nomeLoja, { center: true, bold: true }))
  out.push(line(`Pedido: ${date}`, { center: true }))
  out.push(line(`--- ${origemLabel(order.channel as string)} ---`, { center: true, bold: true }))
  out.push(line(div))

  // Número do pedido em destaque (dobro de altura).
  out.push(line(`#${orderLabel(order as never)}`, { bold: true, double: true }))
  if (isIfood && order.ifood_pickup_code) {
    out.push(line(`Codigo de coleta: ${ascii(order.ifood_pickup_code)}`, { bold: true }))
  }
  out.push(line(ascii(order.customer_name)))
  out.push(line(ascii(order.customer_phone)))
  if (nPedidosCliente !== null) {
    out.push(line(
      nPedidosCliente <= 0
        ? 'Cliente novo na loja'
        : `Cliente: ${nPedidosCliente} pedido${nPedidosCliente === 1 ? '' : 's'} na loja`,
      { bold: nPedidosCliente <= 0 }
    ))
  }
  out.push(line(div))

  if (isPickup) {
    out.push(line('*** RETIRADA ***', { center: true, bold: true }))
    for (const l of wrap(`RETIRAR EM: ${pickupAddress || 'CONFIRMAR COM A LOJA'}`)) out.push(line(l))
  } else {
    for (const l of wrap(addrLine)) out.push(line(l))
    for (const l of wrap(cityLine)) out.push(line(l))
  }
  out.push(line(div))

  for (const item of items) {
    const nomeItem = `${item.quantity}x ${ascii(item.product_name)}`
    const preco = R(item.subtotal_cents as number)
    if (nomeItem.length + preco.length + 1 <= width) {
      out.push(line(row(nomeItem, preco)))
    } else {
      // Nome longo: QUEBRA em linhas próprias (não corta) e o preço à direita
      // logo abaixo.
      for (const l of wrap(nomeItem)) out.push(line(l))
      out.push(line(row('', preco)))
    }
    const addons = ((item.addon_selections as { selectedOptions: { name: string }[] }[]) || [])
      .flatMap((a) => a.selectedOptions.map((o) => `  + ${ascii(o.name)}`))
    for (const a of addons) out.push(line(a))
    if (item.notes) out.push(line(`  obs: ${ascii(item.notes)}`, { bold: true }))
  }

  out.push(line(div))
  out.push(line(row('Subtotal', R(order.subtotal_cents as number))))
  out.push(line(row(isPickup ? 'Retirada' : 'Entrega', R(order.delivery_fee_cents as number))))
  out.push(line(dbl))
  out.push(line(row('TOTAL', R(order.total_cents as number)), { bold: true }))
  out.push(line(dbl))
  // iFood: quanto o cliente efetivamente pagou (com desconto/cupom e taxa do
  // iFood), que é diferente do que a loja recebe (o TOTAL acima).
  if (isIfood && typeof ep?.total?.orderAmount === 'number') {
    if (typeof ep.total.benefits === 'number' && ep.total.benefits > 0) {
      out.push(line(row('Desconto iFood', '-' + Rf(ep.total.benefits))))
    }
    out.push(line(row('Cliente pagou', Rf(ep.total.orderAmount)), { bold: true }))
  }
  out.push(line(`Pagto: ${PAYMENT[order.payment_method as string] || ascii(order.payment_method)}`, { bold: true }))
  if (order.change_for_cents) out.push(line(`Troco para: ${R(order.change_for_cents as number)}`))
  if (order.notes) {
    out.push(line(div))
    out.push(line('Obs:', { bold: true }))
    for (const l of wrap(String(order.notes))) out.push(line(l))
  }
  out.push(line(div))
  out.push(line('Obrigado!', { center: true }))

  out.push(CMD.feedCut)
  return Buffer.concat(out)
}

// ── Envio RAW ao spooler ────────────────────────────────────────────────────
// Escreve o buffer num .bin e chama um script PowerShell que faz P/Invoke em
// winspool.drv. `datatype = "RAW"` é o que pula a renderização GDI do driver.
const PS_RAW_PRINT = `
param([string]$BinPath, [string]$Printer)
$bytes = [System.IO.File]::ReadAllBytes($BinPath)
$code = @"
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
"@
Add-Type -TypeDefinition $code -Language CSharp
[RawPrinter]::Send($Printer, $bytes)
`.trim()

export function printRawEscPos(buffer: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpBin = join(app.getPath('temp'), `cardapia-escpos-${randomUUID()}.bin`)
    const tmpPs = join(app.getPath('temp'), `cardapia-rawprint-${randomUUID()}.ps1`)
    try {
      writeFileSync(tmpBin, buffer)
      writeFileSync(tmpPs, PS_RAW_PRINT, 'utf-8')
    } catch (err) {
      reject(err)
      return
    }

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs, '-BinPath', tmpBin, '-Printer', printerName],
      { timeout: 20000, windowsHide: true },
      (err) => {
        try { unlinkSync(tmpBin) } catch { /* ignore */ }
        try { unlinkSync(tmpPs) } catch { /* ignore */ }
        if (err) reject(err)
        else resolve()
      }
    )
  })
}
