import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = dirname(fileURLToPath(import.meta.url))

test('release notes and translated guide links are generated from the public sources', t => {
  const base = mkdtempSync(join(tmpdir(), 'broco-docs-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const guide = join(base, 'docs-site')
  mkdirSync(guide)
  for (const name of ['build.mjs', 'assets', 'en', 'zh']) cpSync(join(source, name), join(guide, name), { recursive: true })
  symlinkSync(join(source, 'node_modules'), join(guide, 'node_modules'))
  cpSync(join(source, '../package.json'), join(base, 'package.json'))
  const log = readFileSync(join(source, '../CHANGELOG.md'), 'utf8').replace('### English', '### English\n\nRelease-note fixture.')
  writeFileSync(join(base, 'CHANGELOG.md'), log)
  const out = join(base, 'rendered')
  const build = () => execFileSync(process.execPath, [join(guide, 'build.mjs'), out], { stdio: 'pipe' })
  build()
  const english = readFileSync(join(out, 'changelog/index.html'), 'utf8')
  const chinese = readFileSync(join(out, 'zh/changelog/index.html'), 'utf8')
  assert.match(english, /Release-note fixture\./)
  assert.doesNotMatch(chinese, /Release-note fixture\./)
  assert.match(english, /href="\.\.\/docs\/upgrade\/"/)
  assert.match(chinese, /href="\.\.\/\.\.\/zh\/docs\/upgrade\/"/)
  assert.match(english, /broco-social-preview-1280x640\.png/)
  assert.ok(existsSync(join(out, 'favicon.ico')))
  assert.ok(existsSync(join(out, 'assets/broco-favicon-64.png')))
  assert.ok(existsSync(join(out, 'assets/broco-foreman-256.png')))
  assert.ok(existsSync(join(out, 'assets/fonts/instrument-sans-latin.woff2')))
  assert.ok(existsSync(join(out, 'assets/fonts/jetbrains-mono-latin.woff2')))
  assert.ok(existsSync(join(out, 'guide-assets/guide.js')))
  const commands = readFileSync(join(out, 'zh/docs/commands/index.html'), 'utf8')
  assert.match(commands, /href="\.\.\/\.\.\/\.\.\/docs\/commands\/"/)
  assert.match(commands, /broco shutdown/)
  assert.match(commands, /class="code-block"/)
  assert.match(commands, /class="table-wrap"/)
  assert.match(commands, /class="on-this-page"/)
  const inputs = readFileSync(join(out, 'docs/model-inputs/index.html'), 'utf8')
  assert.match(inputs, /href="https:\/\/github\.com\/earendil-works\/pi\/blob\/main\/packages\/coding-agent\/docs\/rpc\.md"/)
  rmSync(join(guide, 'zh/commands.md'))
  assert.throws(build, /Topic list and zh sources differ/)
  cpSync(join(source, 'zh/commands.md'), join(guide, 'zh/commands.md'))
  writeFileSync(join(base, 'CHANGELOG.md'), log.replace('## ' + JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version, '## 99.0.0'))
  assert.throws(build, /Missing current or duplicate changelog version/)
})
