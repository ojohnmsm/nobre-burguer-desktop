import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Registro técnico em arquivo — para quem mantém o programa, não para quem
 * está no balcão.
 *
 * POR QUE EXISTE
 *
 * A impressão tem um caminho primário (ESC/POS) e uma reserva (HTML). Quando o
 * primário falha, a reserva assume e a comanda sai certa — então NADA fica
 * errado aos olhos da cozinha, e o defeito pode durar semanas sem ninguém
 * notar. Antes só dava para perceber porque a reserva imprimia um cupom com
 * outra cara; agora os dois são idênticos (que é o certo para a cozinha), e o
 * sinal precisava ir para algum lugar.
 *
 * O QUE VAI PARA A TELA E O QUE VEM PARA CÁ
 *
 * Para o lojista, só o que ele pode FAZER: "confira se a comanda saiu",
 * "reimprima pelo cartão". Motivo técnico não ajuda quem está montando pedido
 * às sete da noite — "OpenPrinter falhou (1801)" só assusta. Esse texto vive
 * aqui, com data, pedido e caminho usado, e chega ao dev pela pasta de logs
 * (bandeja -> Abrir pasta de logs).
 *
 * Nunca lança: falhar ao registrar não pode derrubar uma impressão.
 */

const MAX_BYTES = 2 * 1024 * 1024

function pastaDeLogs(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function caminhoDoLog(): string {
  return join(pastaDeLogs(), 'cardapia.log')
}

export function pastaDoLog(): string {
  return pastaDeLogs()
}

/**
 * Gira o arquivo ao passar do teto. Uma geração antiga só: o que interessa é a
 * falha recente, e um PC de balcão não deve acumular log para sempre.
 */
function girarSePreciso(arquivo: string) {
  try {
    if (!existsSync(arquivo)) return
    if (statSync(arquivo).size < MAX_BYTES) return
    renameSync(arquivo, `${arquivo}.1`)
  } catch { /* girar é higiene, não pode impedir o registro */ }
}

function serializar(detalhe: unknown): string {
  if (detalhe === undefined) return ''
  if (detalhe instanceof Error) return ` | ${detalhe.name}: ${detalhe.message}`
  if (typeof detalhe === 'string') return ` | ${detalhe}`
  try {
    return ` | ${JSON.stringify(detalhe)}`
  } catch {
    return ' | [detalhe não serializável]'
  }
}

export function registrar(nivel: 'info' | 'erro', mensagem: string, detalhe?: unknown): void {
  const linha = `${new Date().toISOString()} [${nivel.toUpperCase()}] ${mensagem}${serializar(detalhe)}\n`

  // O console continua recebendo: em desenvolvimento é onde se olha primeiro.
  if (nivel === 'erro') console.error(linha.trimEnd())
  else console.log(linha.trimEnd())

  try {
    const arquivo = caminhoDoLog()
    girarSePreciso(arquivo)
    appendFileSync(arquivo, linha, 'utf-8')
  } catch { /* sem log em disco o programa segue imprimindo */ }
}
