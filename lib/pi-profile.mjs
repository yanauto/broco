import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const sdkCache = new Map()

export function sdkRoot(path) {
  const key = String(path ?? '')
  if (sdkCache.has(key)) return sdkCache.get(key)
  let found = null
  for (const part of key.split(delimiter)) {
    if (!part) continue
    const exe = join(part, 'pi')
    try { accessSync(exe, constants.X_OK); if (!statSync(exe).isFile()) continue } catch { continue }
    let dir = dirname(realpathSync(exe))
    while (dirname(dir) !== dir) {
      try {
        if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@earendil-works/pi-coding-agent') {
          found = dir
          break
        }
      } catch {}
      dir = dirname(dir)
    }
    break
  }
  if (sdkCache.size > 64) sdkCache.clear()
  sdkCache.set(key, found)
  return found
}
