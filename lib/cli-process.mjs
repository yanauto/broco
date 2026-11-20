import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { toolsPath } from './paths.mjs'

const exec = promisify(execFile)
export function executable(name) {
  for (const file of name.includes('/') ? [name] : toolsPath.split(delimiter).map(p => join(p, name))) {
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file } catch {}
  }
  return null
}

const HOST_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_PARENT_SESSION_ID', 'CLAUDE_CODE_AGENT_ID']

function probeEnv(extra = {}) {
  const env = { ...process.env, PATH: toolsPath, PI_OFFLINE: '1', ...extra }
  for (const key of HOST_VARS) delete env[key]
  return env
}

export async function inspectCommand(file, args, cwd, signal) {
  try {
    const r = await exec(file, args, { cwd, env: probeEnv({ NO_COLOR: '1' }), timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) })
    const clean = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '')
    return { ok: true, text: clean, output: clean }
  } catch (err) {
    const output = (String(err?.stdout ?? '') + String(err?.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '')
    return { ok: false, text: '', output }
  }
}

export async function inspectRpc(file, args, cwd, run, kind = 'jsonrpc') {
  const child = spawn(file, args, { cwd, env: probeEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let next = 0
  const fail = () => { for (const p of pending.values()) p.reject(new Error('CLI inspection unavailable')); pending.clear() }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.once('close', fail)
  const closed = new Promise(ok => child.once('close', ok))
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    try {
      const r = JSON.parse(line), p = pending.get(r.id)
      if (!p) return
      pending.delete(r.id)
      if (r.error || r.success === false) p.reject(new Error('CLI inspection unavailable'))
      else p.resolve(kind === 'pi' ? r.data : r.result)
    } catch {}
  })
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
  const request = (method, params = {}) => {
    const id = String(++next)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send(kind === 'pi' ? { id, type: method, ...params } : { id, method, params })
    })
  }
  const timer = setTimeout(() => { fail(); child.kill('SIGKILL') }, 20000)
  timer.unref?.()
  try { return await run(request, send) }
  finally {
    clearTimeout(timer)
    rl.close()
    child.stdin.end()
    child.kill()
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000)
    kill.unref?.()
    await closed
    clearTimeout(kill)
  }
}
