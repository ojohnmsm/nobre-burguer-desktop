import { formatOrderQrPayload } from './barcodePayload'
import { orderLabel, origemLabel } from '../electron/receiptFormat'

/**
 * O CONTEÚDO da comanda, sem saber como vai ser impresso.
 *
 * Mora em src/ e não em electron/ porque é puro (sem Node, sem Electron) e tem
 * dois consumidores: o processo principal do desktop (electron/escpos.ts, que
 * desenha em ESC/POS pelo spooler do Windows ou em HTML) e o app Android
 * (src/android/escpos.ts, que desenha em ESC/POS para a impressora Bluetooth).
 * Uma comanda só — cupom diferente por aparelho confunde quem monta o pedido.
 */

// ── Normalização ASCII (acento vira lixo em térmica) ─────────────────────────
export function ascii(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
}

export type LineOpts = { center?: boolean; bold?: boolean; double?: boolean; qr?: boolean }

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

export type ReceiptOrder = Record<string, unknown>

interface IfoodPayload {
  createdAt?: string
  merchant?: { name?: string }
  customer?: { ordersCountOnMerchant?: number; segmentation?: string }
  total?: { orderAmount?: number; benefits?: number }
}

export function buildReceiptLines(
  order: ReceiptOrder,
  width: 32 | 48 = 32,
  includeReadyQr = false
): ReceiptLine[] {
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
  // Diz de forma inequívoca se o dinheiro já entrou ou se o entregador/balcão
  // precisa receber — antes a comanda só trazia a forma, e Pix pago e dinheiro
  // saíam parecidos.
  const cobraNaPorta = ['cash', 'meal_voucher', 'food_voucher'].includes(String(order.payment_method)) || order.card_on_delivery === true
  if (order.status === 'awaiting_payment') {
    out.push(ln('*** AGUARDANDO PAGAMENTO ***', { center: true, bold: true }))
  } else if (cobraNaPorta) {
    out.push(ln(`*** COBRAR ${isPickup ? 'NA RETIRADA' : 'NA ENTREGA'}: ${R(order.total_cents as number)} ***`, { center: true, bold: true }))
  } else {
    out.push(ln('*** PAGO - NAO COBRAR ***', { center: true, bold: true }))
  }
  if (order.change_for_cents) out.push(ln(`Troco para: ${R(order.change_for_cents as number)}`))
  if (order.notes) {
    out.push(ln(div))
    out.push(ln('Obs:', { bold: true }))
    for (const l of wrap(String(order.notes))) out.push(ln(l))
  }
  out.push(ln(div))
  out.push(ln('Obrigado!', { center: true }))

  // QR do pedido, para o leitor de código de barras/QR marcar "pronto" sem
  // procurar o card no kanban (ver useBarcodeScanner.ts no renderer). Por
  // último, perto do corte — fácil de escanear sem desdobrar a comanda
  // toda. `qr: true` faz os dois caminhos de impressão desenharem o mesmo QR.
  if (includeReadyQr) {
    out.push(ln(formatOrderQrPayload(String(order.id)), { center: true, bold: true, qr: true }))
  }

  return out
}
