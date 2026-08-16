// Builda e publica uma release no GitHub (repo configurado em package.json
// > build.publish) — é isso que os apps já instalados usam pra descobrir
// que tem versão nova (electron-updater, provider "github").
//
// Uso: bump da versão em package.json -> npm run release
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env.local')

let ghToken = process.env.GH_TOKEN
try {
  const env = Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => {
        const idx = l.indexOf('=')
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
      })
  )
  ghToken = ghToken || env.GH_TOKEN
} catch {
  // Sem .env.local — segue só com process.env, se já tiver GH_TOKEN setado.
}

if (!ghToken) {
  console.error(`GH_TOKEN não encontrado (nem em ${envPath}, nem no ambiente).`)
  process.exit(1)
}

console.log('Compilando...')
const build = spawnSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

console.log('\nEmpacotando e publicando no GitHub...')
const publish = spawnSync('npx', ['electron-builder', '--publish', 'always'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, GH_TOKEN: ghToken },
})
process.exit(publish.status ?? 0)
