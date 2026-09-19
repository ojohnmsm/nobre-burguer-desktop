import { useEffect, useRef, type MutableRefObject } from 'react'
import { proximaEtapa } from './orderFlow'
import { orderLabel } from './orderLabel'
import { STATUS_LABELS, type Order, type OrderStatus } from './types'

/** Mesmo prefixo de electron/escpos.ts (qrCode na comanda) — mudar um lado sem o outro quebra a leitura. */
const QR_ORDER_PREFIX = 'PEDIDO:'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Intervalo máximo entre teclas pra ainda contar como rajada de leitor (ms). Calibrar no leitor real. */
const RAJADA_MS = 50

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Meta'])

interface UseBarcodeScannerOptions {
  ordersRef: MutableRefObject<Order[]>
  updateStatus: (id: string, status: OrderStatus) => Promise<void>
  notify: (message: string) => void
  enabled: boolean
}

/**
 * Leitor USB de código de barras/QR: atua como teclado, "digitando" o texto
 * lido + Enter em alta velocidade — sem driver, sem WebHID (que exigiria
 * handshake de permissão em main.ts e reimplementar tradução de scancode).
 * Reconhece a rajada pelo intervalo entre teclas, não por foco: intercepta
 * (preventDefault + stopPropagation, na fase de CAPTURE, antes de qualquer
 * onKeyDown do React) a partir do 2º caractere da rajada, mesmo com foco num
 * campo de texto normal — sem isso, escanear uma comanda com a caixa de
 * resposta do WhatsApp focada (ela fica sobreposta independente da aba
 * ativa) mandaria "PEDIDO:<uuid>" como mensagem pro cliente, porque aquele
 * campo já trata Enter como "enviar". O 1º caractere ainda pode vazar pro
 * campo focado (não dá pra saber que é rajada antes do 2º chegar) — na pior
 * hipótese sobra uma letra solta, cosmético.
 */
export function useBarcodeScanner({ ordersRef, updateStatus, notify, enabled }: UseBarcodeScannerOptions) {
  const bufferRef = useRef('')
  const lastKeyAtRef = useRef(0)
  const emRajadaRef = useRef(false)

  useEffect(() => {
    if (!enabled) return

    function processarScan(codigo: string) {
      if (!codigo.startsWith(QR_ORDER_PREFIX)) return
      const id = codigo.slice(QR_ORDER_PREFIX.length)
      if (!UUID_PATTERN.test(id)) return

      const pedido = ordersRef.current.find(o => o.id === id)
      if (!pedido) {
        notify('Comanda escaneada, mas o pedido não está mais na tela')
        return
      }

      // Só avança pra "pronto" — nunca confirma nem despacha por scan, só o
      // passo que a comanda foi feita pra resolver.
      const proxima = proximaEtapa(pedido)
      if (!proxima || proxima.status !== 'ready_to_pickup') {
        notify(`Pedido #${orderLabel(pedido)} está em "${STATUS_LABELS[pedido.status]}" — não dá pra marcar como pronto por aqui`)
        return
      }

      // updateStatus não devolve sucesso/erro (feedback já é via notify
      // interno dela) — confere o estado depois pra só avisar sucesso quando
      // o pedido realmente mudou (erro, se houve, ela já mostrou sozinha).
      void updateStatus(pedido.id, 'ready_to_pickup').then(() => {
        const atualizado = ordersRef.current.find(o => o.id === id)
        if (atualizado?.status === 'ready_to_pickup') {
          notify(`✅ Pedido #${orderLabel(pedido)} marcado como pronto`)
        }
      })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return
      if (MODIFIER_KEYS.has(event.key)) return

      const agora = Date.now()
      const intervalo = agora - lastKeyAtRef.current
      lastKeyAtRef.current = agora

      if (intervalo > RAJADA_MS) {
        bufferRef.current = ''
        emRajadaRef.current = false
      } else {
        emRajadaRef.current = true
      }

      if (event.key === 'Enter') {
        if (emRajadaRef.current) {
          event.preventDefault()
          event.stopPropagation()
          processarScan(bufferRef.current)
        }
        bufferRef.current = ''
        emRajadaRef.current = false
        return
      }

      // Ignora teclas de controle/navegação (Tab, Backspace, setas...) sem
      // tocar no buffer — só caractere imprimível de verdade entra nele.
      if (event.key.length !== 1) return

      if (emRajadaRef.current) {
        event.preventDefault()
        event.stopPropagation()
      }
      bufferRef.current += event.key
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, ordersRef, updateStatus, notify])
}
