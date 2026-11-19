import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, Plus, Search, ShoppingCart, Trash2, X } from 'lucide-react'
import {
  fmtMoney,
  PAYMENT_METHODS_BALCAO,
  type CarrinhoComplemento,
  type CarrinhoItem,
  type CatalogoCategoria,
  type CatalogoProduto,
} from '../types'
import type { PedidoBalcaoInput } from '../electron-api'
import { useConfirmar } from './Confirmar'

/** Linha do carrinho com observação própria (o tipo compartilhado ainda não tem `notes`). */
type ItemCarrinho = CarrinhoItem & { notes?: string | null }

interface Rascunho {
  carrinho: ItemCarrinho[]
  nome: string
  telefone: string
  fulfillmentType: 'pickup' | 'delivery'
  cep: string
  endereco: string
  numero: string
  complemento: string
  paymentMethod: string
  changeFor: string
  notes: string
}

// Rascunho por loja: sair da aba desmonta este componente, e perder o carrinho
// no meio de um pedido de balcão custa o pedido. sessionStorage some ao fechar o app.
const chaveRascunho = (connectionId: string) => `cardapia.rascunho.balcao.${connectionId}`

function lerRascunho(connectionId: string | undefined): Partial<Rascunho> {
  if (!connectionId) return {}
  try {
    const bruto = window.sessionStorage.getItem(chaveRascunho(connectionId))
    return bruto ? (JSON.parse(bruto) as Partial<Rascunho>) : {}
  } catch {
    return {}
  }
}

function gravarRascunho(connectionId: string | undefined, r: Rascunho | null) {
  if (!connectionId) return
  try {
    if (r) window.sessionStorage.setItem(chaveRascunho(connectionId), JSON.stringify(r))
    else window.sessionStorage.removeItem(chaveRascunho(connectionId))
  } catch {
    // armazenamento indisponível: o rascunho simplesmente não persiste
  }
}

interface Props {
  stores: { id: string; storeName: string | null }[]
  onPedidoCriado: (info: { orderId: string; totalCents: number }) => void
}

function novaChave(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Preço unitário estimado — soma "sum" dos complementos, que é a regra mais comum. O valor de verdade sempre vem do servidor ao fechar. */
function precoEstimado(produto: CatalogoProduto, variationId: string | null, complementos: CarrinhoComplemento[], categorias: CatalogoCategoria[]): number {
  const base = variationId
    ? produto.variacoes.find((v) => v.id === variationId)?.precoCents ?? produto.precoCents
    : produto.precoCents
  const grupos = produto.gruposComplemento
  const totalComplementos = complementos.reduce((soma, sel) => {
    const grupo = grupos.find((g) => g.id === sel.groupId)
    const opcoes = grupo?.options.filter((o) => sel.optionIds.includes(o.id)) ?? []
    return soma + opcoes.reduce((s, o) => s + o.precoCents, 0)
  }, 0)
  void categorias
  return base + totalComplementos
}

function EscolhaProdutoModal({
  produto,
  onAdicionar,
  onClose,
}: {
  produto: CatalogoProduto
  onAdicionar: (item: ItemCarrinho) => void
  onClose: () => void
}) {
  const [variationId, setVariationId] = useState<string | null>(produto.variacoes[0]?.id ?? null)
  const [selecoes, setSelecoes] = useState<Record<string, string[]>>({})
  const [quantidade, setQuantidade] = useState(1)
  const [observacao, setObservacao] = useState('')

  function alternarOpcao(groupId: string, optionId: string, max: number) {
    setSelecoes((prev) => {
      const atuais = prev[groupId] ?? []
      if (atuais.includes(optionId)) {
        return { ...prev, [groupId]: atuais.filter((id) => id !== optionId) }
      }
      const proximas = max === 1 ? [optionId] : [...atuais, optionId].slice(-max)
      return { ...prev, [groupId]: proximas }
    })
  }

  const gruposIncompletos = produto.gruposComplemento.filter(
    (g) => g.minSelections > 0 && (selecoes[g.id]?.length ?? 0) < g.minSelections
  )

  function confirmar() {
    if (gruposIncompletos.length > 0) return
    const addonSelections: CarrinhoComplemento[] = produto.gruposComplemento
      .filter((g) => (selecoes[g.id]?.length ?? 0) > 0)
      .map((g) => ({
        groupId: g.id,
        groupNome: g.nome,
        optionIds: selecoes[g.id] ?? [],
        opcoesNomes: g.options.filter((o) => selecoes[g.id]?.includes(o.id)).map((o) => o.nome),
      }))
    const variationNome = variationId ? produto.variacoes.find((v) => v.id === variationId)?.nome ?? null : null
    onAdicionar({
      chave: novaChave(),
      productId: produto.id,
      productNome: produto.nome,
      variationId,
      variationNome,
      quantity: quantidade,
      notes: observacao.trim() || null,
      addonSelections,
      precoUnitarioEstimadoCents: precoEstimado(produto, variationId, addonSelections, []),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-md max-h-[85vh] overflow-y-auto p-4 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-[var(--text)]">{produto.nome}</h3>
          <button onClick={onClose} aria-label="Fechar" className="p-2.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--border-light)]">
            <X size={16} />
          </button>
        </div>

        {produto.variacoes.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--text-muted)]">Tamanho</p>
            {produto.variacoes.map((v) => (
              <label key={v.id} className="flex items-center justify-between gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm cursor-pointer">
                <span className="flex items-center gap-2">
                  <input type="radio" name="variacao" checked={variationId === v.id} onChange={() => setVariationId(v.id)} className="accent-[var(--primary)]" />
                  {v.nome}
                </span>
                <span className="text-[var(--text-muted)]">{fmtMoney(v.precoCents)}</span>
              </label>
            ))}
          </div>
        )}

        {produto.gruposComplemento.map((grupo) => (
          <div key={grupo.id} className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--text-muted)]">
              {grupo.nome}
              {grupo.minSelections > 0 && <span className="text-[var(--danger)]"> · obrigatório</span>}
              {grupo.maxSelections > 1 && <span> · até {grupo.maxSelections}</span>}
            </p>
            {grupo.options.map((opcao) => (
              <label key={opcao.id} className="flex items-center justify-between gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm cursor-pointer">
                <span className="flex items-center gap-2">
                  <input
                    type={grupo.maxSelections === 1 ? 'radio' : 'checkbox'}
                    name={grupo.id}
                    checked={(selecoes[grupo.id] ?? []).includes(opcao.id)}
                    onChange={() => alternarOpcao(grupo.id, opcao.id, grupo.maxSelections)}
                    className="accent-[var(--primary)]"
                  />
                  {opcao.nome}
                </span>
                <span className="text-[var(--text-muted)]">{opcao.precoCents > 0 ? `+${fmtMoney(opcao.precoCents)}` : 'grátis'}</span>
              </label>
            ))}
          </div>
        ))}

        <label className="block text-xs font-semibold text-[var(--text-muted)]">
          Observação do item
          <input
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="Ex.: sem cebola"
            maxLength={140}
            className="mt-1.5 w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm font-normal text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
          />
        </label>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--border-light)]">
          <div className="flex items-center gap-3">
            <button onClick={() => setQuantidade((q) => Math.max(1, q - 1))} aria-label="Menos um" className="w-10 h-10 flex items-center justify-center rounded-lg border border-[var(--border)] hover:bg-[var(--border-light)]">
              <Minus size={14} />
            </button>
            <span className="w-6 text-center font-semibold">{quantidade}</span>
            <button onClick={() => setQuantidade((q) => q + 1)} aria-label="Mais um" className="w-10 h-10 flex items-center justify-center rounded-lg border border-[var(--border)] hover:bg-[var(--border-light)]">
              <Plus size={14} />
            </button>
          </div>
          <button
            onClick={confirmar}
            disabled={gruposIncompletos.length > 0}
            aria-label="Adicionar ao carrinho"
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--primary-fg)] font-semibold rounded-xl px-5 py-2.5 text-sm transition-colors"
          >
            Adicionar
          </button>
        </div>
      </div>
    </div>
  )
}

export function NovoPedido({ stores, onPedidoCriado }: Props) {
  const confirmar = useConfirmar()
  const [connectionId, setConnectionId] = useState<string | undefined>(stores[0]?.id)
  // Lido uma vez, na montagem, para a loja que abre selecionada.
  const rascunhoInicial = useRef<Partial<Rascunho>>(lerRascunho(stores[0]?.id))
  const envioEmCurso = useRef(false)
  const [categorias, setCategorias] = useState<CatalogoCategoria[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erroCatalogo, setErroCatalogo] = useState('')
  const [busca, setBusca] = useState('')
  const [categoriaAtivaId, setCategoriaAtivaId] = useState<string | null>(null)

  const [carrinho, setCarrinho] = useState<ItemCarrinho[]>(() => rascunhoInicial.current.carrinho ?? [])
  const [produtoEscolhendo, setProdutoEscolhendo] = useState<CatalogoProduto | null>(null)

  const [nome, setNome] = useState(() => rascunhoInicial.current.nome ?? '')
  const [telefone, setTelefone] = useState(() => rascunhoInicial.current.telefone ?? '')
  const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>(() => rascunhoInicial.current.fulfillmentType ?? 'pickup')
  const [cep, setCep] = useState(() => rascunhoInicial.current.cep ?? '')
  const [endereco, setEndereco] = useState(() => rascunhoInicial.current.endereco ?? '')
  const [numero, setNumero] = useState(() => rascunhoInicial.current.numero ?? '')
  const [complemento, setComplemento] = useState(() => rascunhoInicial.current.complemento ?? '')
  const [paymentMethod, setPaymentMethod] = useState(() => rascunhoInicial.current.paymentMethod ?? 'cash')
  const [changeFor, setChangeFor] = useState(() => rascunhoInicial.current.changeFor ?? '')
  const [notes, setNotes] = useState(() => rascunhoInicial.current.notes ?? '')
  const [enviando, setEnviando] = useState(false)
  const [erroEnvio, setErroEnvio] = useState('')

  useEffect(() => {
    if (!connectionId && stores.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza com a lista de lojas ao montar/mudar, não busca dado.
      setConnectionId(stores[0].id)
    }
  }, [stores, connectionId])

  // Guarda o rascunho a cada mudança; vazio, apaga a chave.
  useEffect(() => {
    const vazio = carrinho.length === 0 && !nome && !telefone && !cep && !endereco && !numero
      && !complemento && !changeFor && !notes
    gravarRascunho(connectionId, vazio ? null : {
      carrinho, nome, telefone, fulfillmentType, cep, endereco, numero, complemento, paymentMethod, changeFor, notes,
    })
  }, [connectionId, carrinho, nome, telefone, fulfillmentType, cep, endereco, numero, complemento, paymentMethod, changeFor, notes])

  async function trocarLoja(novaId: string) {
    if (novaId === connectionId) return
    if (carrinho.length > 0) {
      const ok = await confirmar({
        titulo: 'Trocar de loja e esvaziar o carrinho?',
        descricao: 'Os itens do carrinho são do cardápio da loja atual e não valem na outra.',
        confirmarRotulo: 'Trocar e esvaziar',
        cancelarRotulo: 'Manter loja',
        perigo: true,
      })
      if (!ok) return
      setCarrinho([])
      gravarRascunho(connectionId, null)
    }
    setConnectionId(novaId)
    setCategoriaAtivaId(null)
  }

  useEffect(() => {
    let ativo = true
    setCarregando(true)
    setErroCatalogo('')
    void Promise.resolve()
      .then(() => window.api.getCatalogo(connectionId))
      .then((res) => {
        if (!ativo) return
        if (res.ok) {
          setCategorias(res.categorias)
          setCategoriaAtivaId((atual) => atual ?? res.categorias[0]?.id ?? null)
        } else {
          setErroCatalogo(res.error)
        }
      })
      .finally(() => { if (ativo) setCarregando(false) })
    return () => { ativo = false }
  }, [connectionId])

  const buscaAtiva = busca.trim().length > 0
  const produtosDaBusca = useMemo(() => {
    if (!buscaAtiva) return []
    const termo = busca.trim().toLowerCase()
    return categorias.flatMap((c) => c.produtos.filter((p) => p.nome.toLowerCase().includes(termo)))
  }, [categorias, busca, buscaAtiva])

  const categoriaAtiva = categorias.find((c) => c.id === categoriaAtivaId) ?? null
  const produtosExibidos = buscaAtiva ? produtosDaBusca : categoriaAtiva?.produtos ?? []

  function adicionarSimples(produto: CatalogoProduto) {
    setCarrinho((prev) => {
      const existente = prev.find((i) => i.productId === produto.id && i.variationId === null && i.addonSelections.length === 0 && !i.notes)
      if (existente) {
        return prev.map((i) => i.chave === existente.chave ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, {
        chave: novaChave(),
        notes: null,
        productId: produto.id,
        productNome: produto.nome,
        variationId: null,
        variationNome: null,
        quantity: 1,
        addonSelections: [],
        precoUnitarioEstimadoCents: produto.precoCents,
      }]
    })
  }

  function abrirEscolha(produto: CatalogoProduto) {
    if (produto.variacoes.length === 0 && produto.gruposComplemento.length === 0) {
      adicionarSimples(produto)
      return
    }
    setProdutoEscolhendo(produto)
  }

  function alterarQuantidade(chave: string, delta: number) {
    setCarrinho((prev) => prev
      .map((i) => i.chave === chave ? { ...i, quantity: i.quantity + delta } : i)
      .filter((i) => i.quantity > 0))
  }

  function alterarObservacao(chave: string, texto: string) {
    setCarrinho((prev) => prev.map((i) => i.chave === chave ? { ...i, notes: texto } : i))
  }

  const subtotalCents = carrinho.reduce((soma, item) => soma + item.precoUnitarioEstimadoCents * item.quantity, 0)

  function limparFormulario() {
    setCarrinho([])
    setNome('')
    setTelefone('')
    setFulfillmentType('pickup')
    setCep('')
    setEndereco('')
    setNumero('')
    setComplemento('')
    setPaymentMethod('cash')
    setChangeFor('')
    setNotes('')
    gravarRascunho(connectionId, null)
  }

  async function fecharPedido() {
    if (envioEmCurso.current) return
    setErroEnvio('')
    if (carrinho.length === 0) { setErroEnvio('Não deu para fechar o pedido · o carrinho está vazio'); return }
    if (nome.trim().length < 2) { setErroEnvio('Não deu para fechar o pedido · falta o nome do cliente'); return }
    const telefoneDigitos = telefone.replace(/\D/g, '')
    if (telefoneDigitos.length < 10) { setErroEnvio('Não deu para fechar o pedido · o telefone precisa do DDD'); return }
    if (fulfillmentType === 'delivery') {
      if (cep.replace(/\D/g, '').length !== 8) { setErroEnvio('Não deu para fechar o pedido · o CEP precisa de 8 números'); return }
      if (endereco.trim().length < 2 || numero.trim().length < 1) { setErroEnvio('Não deu para fechar o pedido · falta o endereço ou o número'); return }
    }
    const trocoCents = paymentMethod === 'cash' && changeFor.trim()
      ? Math.round(Number(changeFor.replace(',', '.')) * 100)
      : null
    if (trocoCents != null && (!Number.isFinite(trocoCents) || trocoCents <= 0)) {
      setErroEnvio('Não deu para fechar o pedido · o valor do troco não é um número')
      return
    }

    const metodo = PAYMENT_METHODS_BALCAO.find((m) => m.value === paymentMethod)
    const payload: PedidoBalcaoInput = {
      items: carrinho.map((item) => ({
        productId: item.productId,
        variationId: item.variationId,
        quantity: item.quantity,
        notes: item.notes?.trim() || null,
        addonSelections: item.addonSelections.map((a) => ({ groupId: a.groupId, optionIds: a.optionIds })),
      })),
      customerName: nome.trim(),
      customerPhone: telefoneDigitos,
      fulfillmentType,
      cep: fulfillmentType === 'delivery' ? cep.replace(/\D/g, '') : null,
      address: fulfillmentType === 'delivery' ? endereco.trim() : null,
      addressNumber: fulfillmentType === 'delivery' ? numero.trim() : null,
      addressComplement: fulfillmentType === 'delivery' ? (complemento.trim() || null) : null,
      paymentMethod,
      cardOnDelivery: metodo?.cardOnDelivery === true,
      changeForCents: trocoCents,
      notes: notes.trim() || null,
    }

    envioEmCurso.current = true
    setEnviando(true)
    try {
      const res = await window.api.criarPedidoBalcao(payload, connectionId)
      if (!res.ok) { setErroEnvio(res.error); return }
      onPedidoCriado({ orderId: res.orderId, totalCents: res.totalCents })
      limparFormulario()
    } catch {
      setErroEnvio('Não deu para fechar o pedido · sem resposta do servidor. Confira a fila antes de tentar de novo.')
    } finally {
      envioEmCurso.current = false
      setEnviando(false)
    }
  }

  return (
    <div className="h-full overflow-hidden flex">
      {/* Cardápio */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-[var(--border)]">
        <div className="p-3 space-y-2 border-b border-[var(--border)] flex-shrink-0">
          {stores.length > 1 && (
            <select
              value={connectionId}
              onChange={(e) => void trocarLoja(e.target.value)}
              aria-label="Loja do pedido"
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.storeName ?? 'Loja'}</option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-xmuted)]" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar produto"
              aria-label="Buscar produto"
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl pl-9 pr-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
            />
          </div>
          {!buscaAtiva && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {categorias.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategoriaAtivaId(c.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                    categoriaAtivaId === c.id ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {c.nome}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {carregando ? (
            <p className="text-center py-8 text-[var(--text-muted)] flex items-center justify-center gap-2 text-sm"><Loader2 size={14} className="animate-spin" /> Carregando o cardápio…</p>
          ) : erroCatalogo ? (
            <p className="text-center py-8 text-[var(--danger)] text-sm">{erroCatalogo}</p>
          ) : produtosExibidos.length === 0 ? (
            <p className="text-center py-8 text-[var(--text-xmuted)] text-sm">Nenhum produto com esse nome.</p>
          ) : (
            produtosExibidos.map((p) => (
              <button
                key={p.id}
                onClick={() => abrirEscolha(p)}
                className="w-full flex items-center justify-between gap-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3 text-left hover:border-[var(--primary)] transition-colors"
              >
                <span className="text-sm font-medium text-[var(--text)]">{p.nome}</span>
                <span className="text-sm text-[var(--text-muted)] flex-shrink-0">
                  {p.variacoes.length > 0 ? `a partir de ${fmtMoney(Math.min(...p.variacoes.map((v) => v.precoCents)))}` : fmtMoney(p.precoCents)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Carrinho + checkout */}
      <div className="w-96 flex-shrink-0 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wide flex items-center gap-1.5">
            <ShoppingCart size={13} /> Carrinho
          </h3>
          {carrinho.length === 0 ? (
            <p className="text-xs text-[var(--text-xmuted)] py-4 text-center">Toque num produto para adicionar ao pedido.</p>
          ) : (
            carrinho.map((item) => (
              <div key={item.chave} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text)] truncate">{item.productNome}{item.variationNome ? ` — ${item.variationNome}` : ''}</p>
                    {item.addonSelections.length > 0 && (
                      <p className="text-[11px] text-[var(--text-muted)] truncate">{item.addonSelections.flatMap((a) => a.opcoesNomes).join(', ')}</p>
                    )}
                  </div>
                  <button onClick={() => alterarQuantidade(item.chave, -item.quantity)} aria-label={`Remover ${item.productNome}`} className="p-2.5 rounded-lg text-[var(--text-xmuted)] hover:bg-red-500/10 hover:text-[var(--danger)] flex-shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  value={item.notes ?? ''}
                  onChange={(e) => alterarObservacao(item.chave, e.target.value)}
                  placeholder="Observação do item (ex.: sem cebola)"
                  aria-label={`Observação de ${item.productNome}`}
                  maxLength={140}
                  className="w-full bg-[var(--card)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]"
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button onClick={() => alterarQuantidade(item.chave, -1)} aria-label="Menos um" className="w-9 h-9 flex items-center justify-center rounded-md border border-[var(--border)] hover:bg-[var(--border-light)]">
                      <Minus size={11} />
                    </button>
                    <span className="w-5 text-center text-sm font-semibold">{item.quantity}</span>
                    <button onClick={() => alterarQuantidade(item.chave, 1)} aria-label="Mais um" className="w-9 h-9 flex items-center justify-center rounded-md border border-[var(--border)] hover:bg-[var(--border-light)]">
                      <Plus size={11} />
                    </button>
                  </div>
                  <span className="text-sm font-semibold text-[var(--text)]">{fmtMoney(item.precoUnitarioEstimadoCents * item.quantity)}</span>
                </div>
              </div>
            ))
          )}

          {carrinho.length > 0 && (
            <div className="flex items-center justify-between pt-2 border-t border-[var(--border-light)] text-sm font-bold text-[var(--text)]">
              <span>{fulfillmentType === 'delivery' ? 'Subtotal, sem a taxa de entrega' : 'Subtotal estimado'}</span>
              <span>{fmtMoney(subtotalCents)}</span>
            </div>
          )}

          <div className="pt-3 space-y-2.5 border-t border-[var(--border-light)]">
            <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do cliente"
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
            <input value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="Telefone (com DDD)"
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />

            <div className="flex gap-1.5">
              <button onClick={() => setFulfillmentType('pickup')} aria-pressed={fulfillmentType === 'pickup'} className={`flex-1 min-h-11 py-2 rounded-lg text-xs font-semibold ${fulfillmentType === 'pickup' ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-muted)]'}`}>Retirada</button>
              <button onClick={() => setFulfillmentType('delivery')} aria-pressed={fulfillmentType === 'delivery'} className={`flex-1 min-h-11 py-2 rounded-lg text-xs font-semibold ${fulfillmentType === 'delivery' ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-muted)]'}`}>Entrega</button>
            </div>

            {fulfillmentType === 'delivery' && (
              <div className="grid grid-cols-2 gap-2">
                <input value={cep} onChange={(e) => setCep(e.target.value)} placeholder="CEP" className="col-span-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
                <input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Endereço" className="col-span-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
                <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Número" className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
                <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Complemento" className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
            )}

            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]">
              {PAYMENT_METHODS_BALCAO.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {paymentMethod === 'cash' && (
              <input value={changeFor} onChange={(e) => setChangeFor(e.target.value)} placeholder="Troco para quanto? (opcional)"
                className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)]" />
            )}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações do pedido (opcional)" rows={2}
              className="w-full bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm placeholder:text-[var(--text-xmuted)] focus:outline-none focus:border-[var(--primary)] resize-none" />
          </div>
        </div>

        <div className="p-3 border-t border-[var(--border)] flex-shrink-0 space-y-2">
          {erroEnvio && <p className="text-[var(--danger)] text-xs bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">{erroEnvio}</p>}
          <button
            onClick={() => void fecharPedido()}
            disabled={enviando || carrinho.length === 0}
            aria-label="Fechar pedido"
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-colors bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--primary-fg)]"
          >
            {enviando ? <><Loader2 size={15} className="animate-spin" /> Enviando o pedido…</> : fulfillmentType === 'delivery' ? `Fechar pedido — ${fmtMoney(subtotalCents)}, sem a taxa de entrega` : `Fechar pedido — ${fmtMoney(subtotalCents)}`}
          </button>
        </div>
      </div>

      {produtoEscolhendo && (
        <EscolhaProdutoModal
          produto={produtoEscolhendo}
          onClose={() => setProdutoEscolhendo(null)}
          onAdicionar={(item) => {
            setCarrinho((prev) => [...prev, item])
            setProdutoEscolhendo(null)
          }}
        />
      )}
    </div>
  )
}
