import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { repo } from '../lib/paths.mjs'
import { writeFakeCli } from './harness.mjs'

test('installed layout uses the stand-in user profile for OAuth and a project-owned pi session', async t => {
  const { cpSync } = await import('node:fs')
  mkdirSync(join(repo, '.sandbox'), { recursive: true })
  const base = mkdtempSync(join(repo, '.sandbox', 'installed-layout-'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const installed = join(base, 'package')
  cpSync(join(repo, 'lib'), join(installed, 'lib'), { recursive: true })
  const profile = join(base, 'user')
  const bin = join(base, 'path')
  const data = join(profile, '.broco')
  mkdirSync(join(profile, '.pi', 'agent'), { recursive: true })
  mkdirSync(bin)
  mkdirSync(data)
  const sentinel = join(profile, '.pi', 'agent', 'fixture-only')
  writeFileSync(sentinel, 'stand-in login')
  writeFakeCli(bin, 'pi', [
    "import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'",
    "const args=process.argv.slice(2), dir=process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(),'.pi','agent')",
    "if(args[0]==='auth' || fs.readFileSync(path.join(dir,'fixture-only'),'utf8')!=='stand-in login') process.exit(3)",
    "console.log(JSON.stringify({home:os.homedir(),dir,sessions:process.env.PI_CODING_AGENT_SESSION_DIR,args,tz:process.env.TZ}))"
  ])
  const script = [
    "import path from 'node:path'; import { home, isolated } from './lib/paths.mjs'; import { spawnPi } from './lib/pi.mjs'; import { once } from 'node:events'",
    "if(isolated) throw new Error('Unexpected development profile')",
    "const s=path.join(home,'projects','example','sessions')",
    "const {child}=await spawnPi('openai-codex/example',process.cwd(),path.join(home,'workers','tag'),['--session-dir',s,'--model','openai-codex/example'])",
    "child.stdout.pipe(process.stdout);child.stdin.end();const [code]=await once(child,'close');process.exitCode=code"
  ].join('\n')
  const minPath = process.platform === 'win32'
    ? [bin, dirname(process.execPath), process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : ''].filter(Boolean).join(delimiter)
    : [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter)
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: installed,
    env: {
      HOME: profile,
      USERPROFILE: profile,
      PATH: minPath,
      TZ: 'Pacific/Auckland',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {})
    }
  })
  const evidence = JSON.parse(stdout)
  assert.equal(evidence.dir, join(profile, '.pi', 'agent'))
  assert.equal(evidence.sessions, join(data, 'projects', 'example', 'sessions'))
  assert.equal(evidence.tz, 'Pacific/Auckland')
  assert.deepEqual(readdirSync(evidence.dir), ['fixture-only'])
})
