import { useEffect, useRef, type MutableRefObject } from 'react'
import { proximaEtapa } from './orderFlow'
import { orderLabel } from './orderLabel'
import { STATUS_LABELS, type Order } from './types'
import type { ScanReadyResult } from './electron-api'

/** Mesmo prefixo de electron/escpos.ts — mudar um lado sem o outro quebra a leitura. */
const QR_ORDER_PREFIX = 'PEDIDO:'
const QR_TEST_CODE = `${QR_ORDER_PREFIX}TESTE`

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Leitores HID baratos podem vir configurados com atraso entre caracteres. */
const RAJADA_MS = 80

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Meta'])
const TERMINATORS = new Set(['Enter', 'Tab'])

interface EditableSnapshot {
  element: HTMLInputElement | HTMLTextAreaElement
  value: string
  selectionStart: number | null
  selectionEnd: number | null
}

interface UseBarcodeScannerOptions {
  ordersRef: MutableRefObject<Order[]>
  markReady: (id: string, connectionId?: string) => Promise<ScanReadyResult>
  notify: (message: string) => void
  enabled: boolean
}

function snapshotEditable(target: EventTarget | null): EditableSnapshot | null {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return null
  return {
    element: target,
    value: target.value,
    selectionStart: target.selectionStart,
    selectionEnd: target.selectionEnd,
  }
}

/**
 * O primeiro caractere chega ao campo antes de sabermos que é um scanner. Ao
 * confirmar a rajada, volta o valor controlado pelo React ao que era antes do
 * scan e dispara `input`, para o state não guardar um "P" invisível.
 */
function restoreEditable(snapshot: EditableSnapshot | null) {
  if (!snapshot || !snapshot.element.isConnected) return
  const prototype = snapshot.element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(snapshot.element, snapshot.value)
  else snapshot.element.value = snapshot.value
  snapshot.element.dispatchEvent(new Event('input', { bubbles: true }))
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    snapshot.element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd)
  }
}

/**
 * Leitor USB HID em modo teclado: recebe a rajada de caracteres e o Enter/Tab
 * configurado como sufixo. Funciona em qualquer tela do Cardapia, desde que a
 * janela esteja em foco. O valor de campos editáveis é restaurado após a
 * leitura, portanto o código nunca vira mensagem ou configuração por engano.
 */
export function useBarcodeScanner({ ordersRef, markReady, notify, enabled }: UseBarcodeScannerOptions) {
  const bufferRef = useRef('')
  const lastKeyAtRef = useRef(0)
  const emRajadaRef = useRef(false)
  const editableSnapshotRef = useRef<EditableSnapshot | null>(null)
  const processingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!enabled) return

    async function processarScan(codigo: string) {
      if (codigo === QR_TEST_CODE) {
        notify('✅ Leitor de QR Code funcionando')
        return
      }
      if (!codigo.startsWith(QR_ORDER_PREFIX)) {
        if (codigo.length >= 8) notify('Código lido, mas não é uma comanda do Cardapia')
        return
      }

      const id = codigo.slice(QR_ORDER_PREFIX.length)
      if (!UUID_PATTERN.test(id)) {
        notify('QR Code da comanda inválido')
        return
      }
      if (processingRef.current.has(id)) return

      const pedido = ordersRef.current.find((order) => order.id === id)
      if (pedido) {
        // A validação se repete no servidor. Aqui só devolvemos uma resposta
        // imediata quando o cartão já mostra que a transição não cabe.
        const proxima = proximaEtapa(pedido)
        if (!proxima || proxima.status !== 'ready_to_pickup') {
          notify(`Pedido #${orderLabel(pedido)} está em "${STATUS_LABELS[pedido.status]}" — não dá pra marcar como pronto por aqui`)
          return
        }
      }

      processingRef.current.add(id)
      try {
        const result = await markReady(id, pedido?.connectionId)
        if (!result.ok) {
          notify(result.error)
          return
        }
        if (result.requested) {
          notify(`📡 Pedido #${result.label} enviado ao ${result.channel === 'ifood' ? 'iFood' : '99Food'} — aguardando confirmação`)
          return
        }
        notify(`✅ Pedido #${result.label} marcado como pronto`)
      } catch {
        notify('Não foi possível processar a comanda escaneada')
      } finally {
        processingRef.current.delete(id)
      }
    }

    function resetBuffer() {
      bufferRef.current = ''
      emRajadaRef.current = false
      editableSnapshotRef.current = null
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || MODIFIER_KEYS.has(event.key)) return

      const agora = Date.now()
      const intervalo = agora - lastKeyAtRef.current
      lastKeyAtRef.current = agora

      if (intervalo > RAJADA_MS) {
        resetBuffer()
      } else {
        emRajadaRef.current = true
      }

      if (TERMINATORS.has(event.key)) {
        if (emRajadaRef.current && bufferRef.current.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          restoreEditable(editableSnapshotRef.current)
          void processarScan(bufferRef.current)
        }
        resetBuffer()
        return
      }

      // Teclas de controle/navegação não fazem parte do payload do leitor.
      if (event.key.length !== 1) return
      const candidatoPrefixo = bufferRef.current + event.key
      if (
        bufferRef.current.length > 0
        && bufferRef.current.length < QR_ORDER_PREFIX.length
        && !QR_ORDER_PREFIX.startsWith(candidatoPrefixo)
        && event.key === QR_ORDER_PREFIX[0]
      ) {
        // Um scan começou colado à última tecla humana. Mantém o que já estava
        // no campo e reinicia exatamente no "P" do prefixo da comanda.
        bufferRef.current = ''
        editableSnapshotRef.current = snapshotEditable(event.target)
      }
      if (bufferRef.current.length === 0) {
        editableSnapshotRef.current = snapshotEditable(event.target)
      }
      bufferRef.current += event.key
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, ordersRef, markReady, notify])
}
