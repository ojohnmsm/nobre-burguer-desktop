import { useEffect, useRef, useState } from 'react'
import { X, Send, Bot, User, Headset } from 'lucide-react'
import type { WhatsappConversationDetail, WhatsappMessage } from '../electron-api'

interface Props {
  conversationId: string
  connectionId?: string
  onClose: () => void
  onChanged: () => void
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function bubbleStyle(role: WhatsappMessage['role']) {
  if (role === 'customer') return 'bg-[var(--card)] border border-[var(--border)] self-start'
  if (role === 'human_agent') return 'bg-green-500/10 border border-green-500/30 self-end'
  if (role === 'assistant') return 'bg-[var(--primary-tint)] border border-amber-500/30 self-end'
  return 'bg-[var(--border-light)] border border-[var(--border)] self-center text-[10px] text-[var(--text-muted)]'
}

function roleLabel(role: WhatsappMessage['role']) {
  if (role === 'customer') return null
  if (role === 'human_agent') return <span className="flex items-center gap-1 text-[10px] text-[var(--success)] font-bold"><Headset size={10} /> Atendente</span>
  if (role === 'assistant') return <span className="flex items-center gap-1 text-[10px] text-[var(--primary)] font-bold"><Bot size={10} /> Bot</span>
  return null
}

export function WhatsappPanel({ conversationId, connectionId, onClose, onChanged }: Props) {
  const [conversation, setConversation] = useState<WhatsappConversationDetail | null>(null)
  const [messages, setMessages] = useState<WhatsappMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    try {
      const data = await window.api.getWhatsappMessages(conversationId, connectionId)
      setConversation(data.conversation)
      setMessages(data.messages ?? [])
    } catch {
      setError('Não foi possível carregar a conversa')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void load() }, 0)
    const interval = window.setInterval(() => { void load() }, 5000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, connectionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  async function sendReply() {
    const message = reply.trim()
    if (!message || sending) return
    setSending(true)
    try {
      await window.api.sendWhatsappReply(conversationId, message, connectionId)
      setReply('')
      onChanged()
      window.setTimeout(() => { void load() }, 1500)
    } catch {
      setError('Não foi possível enviar a mensagem')
    } finally {
      setSending(false)
    }
  }

  async function resumeBot() {
    setResuming(true)
    try {
      await window.api.resumeWhatsappBot(conversationId, connectionId)
      onChanged()
      void load()
    } catch {
      setError('Não foi possível devolver a conversa pro bot')
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-[var(--surface)] border-l border-[var(--border)] flex flex-col shadow-[var(--shadow-md)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 p-3 border-b border-[var(--border)]" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          <div className="min-w-0">
            <p className="font-bold text-sm truncate text-[var(--text)]">{conversation?.phone ?? '...'}</p>
            {conversation && (
              <p className="text-[10px] text-[var(--text-muted)]">
                {conversation.status === 'awaiting_human' ? 'Aguardando atendente' : conversation.status === 'human_active' ? 'Atendimento manual' : conversation.status}
                {conversation.handoff_reason ? ` — ${conversation.handoff_reason}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--border-light)] text-[var(--text-muted)] flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loading ? (
            <p className="text-center py-8 text-xs text-[var(--text-xmuted)]">Carregando...</p>
          ) : messages.length === 0 ? (
            <p className="text-center py-8 text-xs text-[var(--text-xmuted)]">Nenhuma mensagem ainda</p>
          ) : (
            messages.filter((message) => message.role !== 'tool').map((message) => (
              <div key={message.id} className={`max-w-[85%] rounded-xl px-3 py-2 flex flex-col gap-0.5 ${bubbleStyle(message.role)}`}>
                {roleLabel(message.role)}
                <p className="text-sm text-[var(--text)] whitespace-pre-wrap break-words">{message.content}</p>
                <span className="text-[9px] text-[var(--text-xmuted)] self-end">{formatTime(message.created_at)}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {error && <p className="text-[var(--danger)] text-xs bg-red-500/10 border border-red-500/20 rounded-xl mx-3 mb-2 px-3 py-2">{error}</p>}

        <div className="border-t border-[var(--border)] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void sendReply() }}
              placeholder="Responder pelo WhatsApp..."
              className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
            <button
              onClick={sendReply}
              disabled={sending || !reply.trim()}
              className="p-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-fg)] disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </div>
          <button
            onClick={resumeBot}
            disabled={resuming}
            className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-xl border border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--text-muted)] transition-colors disabled:opacity-40"
          >
            <User size={12} /> Devolver para o bot
          </button>
        </div>
      </div>
    </div>
  )
}
