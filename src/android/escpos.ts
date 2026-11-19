import QRCode from 'qrcode'
import { ascii, buildReceiptLines, type LineOpts, type ReceiptOrder } from '../receiptLines'

/**
 * Desenho da comanda em ESC/POS para o app Android.
 *
 * O CONTEÚDO vem de `buildReceiptLines` — o mesmo que o desktop imprime. Aqui
 * só muda o tipo dos bytes: o processo principal do Electron usa `Buffer` do
 * Node, que não existe na WebView. Os comandos são os mesmos de
 * electron/escpos.ts; ao mexer num, confira o outro.
 */

const ESC = 0x1b
const GS = 0x1d
const CMD = {
  init: [ESC, 0x40],
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  doubleOn: [GS, 0x21, 0x11],
  doubleOff: [GS, 0x21, 0x00],
  // Avança 4 linhas e corta. Impressora portátil sem guilhotina ignora o corte
  // e fica só com o avanço, que é o que deixa o papel no ponto de rasgar.
  feedCut: [0x0a, 0x0a, 0x0a, 0x0a, GS, 0x56, 66, 0],
}

/** Texto já normalizado para ASCII, um byte por caractere. */
function texto(s: string): number[] {
  const limpo = ascii(s)
  const bytes: number[] = []
  for (let i = 0; i < limpo.length; i += 1) bytes.push(limpo.charCodeAt(i) & 0xff)
  return bytes
}

function linha(text: string, opts: LineOpts): number[] {
  const out: number[] = [...(opts.center ? CMD.alignCenter : CMD.alignLeft)]
  if (opts.bold) out.push(...CMD.boldOn)
  if (opts.double) out.push(...CMD.doubleOn)
  out.push(...texto(text), 0x0a)
  if (opts.double) out.push(...CMD.doubleOff)
  if (opts.bold) out.push(...CMD.boldOff)
  return out
}

/** QR como imagem raster (GS v 0) — clones baratos ignoram o QR nativo (GS ( k). */
function qrCodeRaster(data: string, moduleSize = 6): number[] {
  const modules = QRCode.create(data, { errorCorrectionLevel: 'M' }).modules
  const quietModules = 4
  const sidePixels = (modules.size + quietModules * 2) * moduleSize
  const widthBytes = Math.ceil(sidePixels / 8)
  const pixels = new Uint8Array(widthBytes * sidePixels)

  for (let moduleY = 0; moduleY < modules.size; moduleY += 1) {
    for (let moduleX = 0; moduleX < modules.size; moduleX += 1) {
      if (!modules.get(moduleY, moduleX)) continue
      const startX = (moduleX + quietModules) * moduleSize
      const startY = (moduleY + quietModules) * moduleSize
      for (let y = startY; y < startY + moduleSize; y += 1) {
        for (let x = startX; x < startX + moduleSize; x += 1) {
          pixels[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7)
        }
      }
    }
  }

  return [
    GS, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    sidePixels & 0xff, (sidePixels >> 8) & 0xff,
    ...pixels,
  ]
}

export function buildReceiptEscPos(
  order: ReceiptOrder,
  width: 32 | 48 = 32,
  includeReadyQr = false
): Uint8Array {
  const out: number[] = [...CMD.init]
  for (const l of buildReceiptLines(order, width, includeReadyQr)) {
    if (l.qr) {
      out.push(...CMD.alignCenter, 0x0a, ...qrCodeRaster(l.text), 0x0a, ...CMD.alignLeft)
    } else {
      out.push(...linha(l.text, l))
    }
  }
  out.push(...CMD.feedCut)
  return Uint8Array.from(out)
}

/** O plugin nativo recebe os bytes em base64 — a ponte do Capacitor só passa JSON. */
export function paraBase64(bytes: Uint8Array): string {
  let binario = ''
  const bloco = 0x8000
  for (let i = 0; i < bytes.length; i += bloco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + bloco))
  }
  return btoa(binario)
}
