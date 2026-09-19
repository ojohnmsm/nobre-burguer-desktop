/**
 * O marcador não usa pontuação porque leitores HID configurados como teclado
 * americano podem transformar `:` em `Ç` quando o Windows está em ABNT2.
 */
export const QR_ORDER_MARKER = 'PEDIDO'

const LEGACY_SEPARATORS = new Set([':', ';', 'Ç', 'ç'])

export function formatOrderQrPayload(orderId: string): string {
  return `${QR_ORDER_MARKER}${orderId}`
}

/**
 * Extrai o conteúdo do QR novo e das comandas já impressas. Retorna `null`
 * apenas quando o código não pertence ao Cardapia; UUID e estado do pedido
 * continuam sendo validados pelo chamador e pelo backend.
 */
export function extractOrderQrPayload(value: string): string | null {
  const code = value.trim()
  if (!code.startsWith(QR_ORDER_MARKER)) return null

  let payload = code.slice(QR_ORDER_MARKER.length)
  if (LEGACY_SEPARATORS.has(payload[0] ?? '')) payload = payload.slice(1)
  return payload
}
