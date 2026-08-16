export type NotificationSoundKind = 'order' | 'message'

let audioContext: AudioContext | null = null
const customAudio: Record<NotificationSoundKind, HTMLAudioElement | null> = { order: null, message: null }

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioContext) {
    const AudioContextClass = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return null
    audioContext = new AudioContextClass()
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
  } catch {
    setSound('order', null)
    setSound('message', null)
  }
}

function playCustomOrDefault(kind: NotificationSoundKind) {
  const audio = customAudio[kind]
  if (audio) {
    audio.currentTime = 0
    void audio.play().catch(() => playDefaultTone(kind))
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

// Timbres diferentes por padrão — mesmo sem som customizado configurado,
// pedido novo e mensagem já soam distintos um do outro.
const DEFAULT_TONES: Record<NotificationSoundKind, { notes: number[]; type: OscillatorType }> = {
  order: { notes: [880, 1108, 880], type: 'square' },
  message: { notes: [659, 988], type: 'sine' },
}

function playDefaultTone(kind: NotificationSoundKind): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()

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
