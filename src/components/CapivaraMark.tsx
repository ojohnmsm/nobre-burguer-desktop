/**
 * A marca da Cardapia, a mesma do painel e do cardápio.
 *
 * Duplicada aqui porque este é outro repositório — não há pacote compartilhado
 * entre o app web e o desktop. Se o desenho mudar, muda nos dois; o comentário
 * existe para quem alterar um lembrar do outro.
 */
export function CapivaraMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Cardapia">
      {/* Contorno âmbar nas orelhas: o app roda em fundo quase preto, onde
          orelha escura desaparece e a capivara perde o traço que a distingue. */}
      <ellipse cx="24" cy="31" rx="10.5" ry="12.5" transform="rotate(-20 24 31)" fill="#170D10" stroke="#E8912B" strokeWidth="3" />
      <ellipse cx="76" cy="31" rx="10.5" ry="12.5" transform="rotate(20 76 31)" fill="#170D10" stroke="#E8912B" strokeWidth="3" />
      <path d="M50 17C70 17 84 28 85.5 46C87 60 89 73 85 81C80 89 65 93 50 93C35 93 20 89 15 81C11 73 13 60 14.5 46C16 28 30 17 50 17Z" fill="#E8912B" />
      <path d="M50 39C61 39 67 50 68 63C69 76 67 86 62 89C57 92 43 92 38 89C33 86 31 76 32 63C33 50 39 39 50 39Z" fill="#D67C1F" />
      <circle cx="28" cy="45" r="4.3" fill="#170D10" />
      <circle cx="72" cy="45" r="4.3" fill="#170D10" />
      <ellipse cx="43" cy="64" rx="3" ry="3.8" fill="#170D10" />
      <ellipse cx="57" cy="64" rx="3" ry="3.8" fill="#170D10" />
    </svg>
  )
}
