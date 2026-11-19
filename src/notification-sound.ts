export type NotificationSoundKind = 'order' | 'message' | 'driver'

let audioContext: AudioContext | null = null
const customAudio: Record<NotificationSoundKind, HTMLAudioElement | null> = { order: null, message: null, driver: null }

// ── Estado do áudio e silêncio temporário ──────────────────────────────────
// O navegador/WebView só libera som depois de um toque do usuário. Sem isso o
// alerta falhava calado e a cozinha achava que simplesmente não chegou pedido.
export type EstadoAudio = 'ok' | 'bloqueado' | 'indisponivel'

let estadoAudio: EstadoAudio = 'ok'
let silenciadoAte = 0
const ouvintesEstado = new Set<() => void>()

function definirEstadoAudio(novo: EstadoAudio) {
  if (novo === estadoAudio) return
  estadoAudio = novo
  ouvintesEstado.forEach(cb => cb())
}

export function getEstadoAudio(): EstadoAudio {
  return estadoAudio
}

/** Assina mudanças do estado do áudio e do silêncio. Devolve a função de cancelar. */
export function onEstadoAudio(cb: () => void): () => void {
  ouvintesEstado.add(cb)
  return () => { ouvintesEstado.delete(cb) }
}

/** Silencia os alertas por `minutos`; 0 (ou menos) volta a tocar. */
export function silenciarAlertas(minutos: number): void {
  silenciadoAte = minutos > 0 ? Date.now() + minutos * 60_000 : 0
  ouvintesEstado.forEach(cb => cb())
}

/** Instante (ms) em que o silêncio acaba, ou 0 se não está mudo. */
export function silenciadoAteMs(): number {
  return silenciadoAte > Date.now() ? silenciadoAte : 0
}

/** Tenta liberar o áudio (chamado em qualquer toque/tecla do usuário). */
export function tentarLiberarAudio(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'running') { definirEstadoAudio('ok'); return }
  void ctx.resume().then(() => definirEstadoAudio(ctx.state === 'running' ? 'ok' : 'bloqueado')).catch(() => definirEstadoAudio('bloqueado'))
}

if (typeof window !== 'undefined') {
  const liberar = () => tentarLiberarAudio()
  window.addEventListener('pointerdown', liberar, { capture: true })
  window.addEventListener('keydown', liberar, { capture: true })
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioContext) {
    const AudioContextClass = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) {
      definirEstadoAudio('indisponivel')
      return null
    }
    audioContext = new AudioContextClass()
    audioContext.onstatechange = () => {
      if (audioContext) definirEstadoAudio(audioContext.state === 'running' ? 'ok' : 'bloqueado')
    }
    if (audioContext.state !== 'running') definirEstadoAudio('bloqueado')
  }
  return audioContext
}

function setSound(kind: NotificationSoundKind, url: string | null) {
  if (!url) {
    customAudio[kind] = null
    return
  }
  const audio = new Audio(url)
  audio.preload = 'auto'
  customAudio[kind] = audio
}

/**
 * Busca os sons de notificação configurados centralmente no admin web —
 * antes cada instalação guardava o próprio arquivo local; agora todo mundo
 * usa o mesmo, hospedado no Supabase Storage.
 */
export async function loadNotificationSounds(): Promise<void> {
  try {
    const data = await window.api.getNotificationSounds()
    setSound('order', data?.orderSoundUrl ?? null)
    setSound('message', data?.messageSoundUrl ?? null)
    setSound('driver', data?.driverSoundUrl ?? null)
  } catch {
    setSound('order', null)
    setSound('message', null)
    setSound('driver', null)
  }
}

function playCustomOrDefault(kind: NotificationSoundKind) {
  if (silenciadoAteMs() > 0) return
  const audio = customAudio[kind]
  if (audio) {
    audio.currentTime = 0
    void audio.play().then(() => definirEstadoAudio('ok')).catch(() => playDefaultTone(kind))
    return
  }
  playDefaultTone(kind)
}

/** Alerta de pedido novo não visto. */
export function playOrderAlert(): void {
  playCustomOrDefault('order')
}

/** Alerta de mensagem de cliente não vista (ou WhatsApp desconectado). */
export function playMessageAlert(): void {
  playCustomOrDefault('message')
}

/** Alerta de entregador do iFood que acabou de chegar na loja. */
export function playDriverArrivedAlert(): void {
  playCustomOrDefault('driver')
}

// Timbres diferentes por padrão — mesmo sem som customizado configurado,
// pedido novo, mensagem e entregador já soam distintos.
const DEFAULT_TONES: Record<NotificationSoundKind, { notes: number[]; type: OscillatorType }> = {
  order: { notes: [880, 1108, 880], type: 'square' },
  message: { notes: [659, 988], type: 'sine' },
  driver: { notes: [523, 784, 1046], type: 'triangle' },
}

function playDefaultTone(kind: NotificationSoundKind): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    // Sem toque do usuário o resume() não vale: o estado fica "bloqueado" e a
    // tela mostra isso, em vez de o alerta sumir sem aviso.
    void ctx.resume().then(() => definirEstadoAudio(ctx.state === 'running' ? 'ok' : 'bloqueado')).catch(() => definirEstadoAudio('bloqueado'))
    definirEstadoAudio('bloqueado')
  }

  const { notes, type } = DEFAULT_TONES[kind]
  const now = ctx.currentTime
  notes.forEach((frequency, index) => {
    const offset = index * 0.16
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = type
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, now + offset)
    gain.gain.exponentialRampToValueAtTime(0.55, now + offset + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(now + offset)
    oscillator.stop(now + offset + 0.15)
  })
}
