import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = fileURLToPath(new URL('../', import.meta.url))

export function newestMtime(path) {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let latest = st.mtimeMs
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    latest = Math.max(latest, newestMtime(join(path, entry.name)))
  }
  return latest
}

export function packageBoard({
  root = defaultRoot,
  build = cwd => execFileSync('npm', ['--prefix', 'ui', 'run', 'build'], { cwd, stdio: 'inherit' })
} = {}) {
  const uiDir = join(root, 'ui')
  const uiSrc = join(uiDir, 'src')
  const source = join(uiDir, 'dist')
  const distIndex = join(source, 'index.html')
  const target = join(root, 'bundle', 'board')
  if (existsSync(uiSrc)) {
    const srcTime = Math.max(
      newestMtime(uiSrc),
      newestMtime(join(uiDir, 'public')),
      newestMtime(join(uiDir, 'index.html')),
      newestMtime(join(uiDir, 'vite.config.js'))
    )
    const distTime = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0
    if (!distTime || srcTime > distTime) {
      build(root)
    }
  }
  if (existsSync(distIndex)) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true })
  } else if (!existsSync(join(target, 'index.html'))) {
    throw new Error('Build the board with npm run build --prefix ui before packing broco')
  }
  return target
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageBoard()
}
