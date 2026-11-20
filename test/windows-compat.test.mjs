import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isWithinPath, samePath, socketFor } from '../lib/paths.mjs'
import { sanitizeSetupPath, setupInfo } from '../lib/setup.mjs'
import { getEnvVar, normalizeEnv, parseCmdNodeShim, pathextList, resolveCli, resolveCommand } from '../lib/spawn-cli.mjs'

test('sanitizeSetupPath handles Windows drive letters, UNC paths, semicolon delimiter, ephemeral/shim filtering, and case-insensitive dedupe', () => {
  const raw = [
    'C:\\Users\\alice\\AppData\\Local\\Temp\\broco-tmp',
    'C:\\Windows\\Temp\\scratch',
    'D:\\Temp\\ephemeral',
    'C:\\repo\\node_modules\\.bin',
    'C:\\Users\\alice\\AppData\\Local\\npm-cache\\_npx\\1234\\node_modules\\.bin',
    'C:\\Users\\alice\\.npm\\_npx\\5678\\node_modules\\.bin',
    'C:\\workspace\\cc-bro\\.sandbox\\profile-1\\bin',
    'C:\\workspace\\cc-bro\\test\\fixtures',
    'relative\\bin',
    'C:\\Program Files\\nodejs\\',
    'c:\\program files\\nodejs',
    'C:\\Users\\alice\\AppData\\Roaming\\npm',
    'c:\\users\\alice\\appdata\\roaming\\npm\\',
    'D:\\Tools\\Git\\cmd',
    '\\\\fileserver\\share\\bin',
    'C:\\Missing\\Dir'
  ].join(';')

  const existing = new Set([
    'c:\\program files\\nodejs',
    'c:\\users\\alice\\appdata\\roaming\\npm',
    'd:\\tools\\git\\cmd',
    '\\\\fileserver\\share\\bin',
    'c:\\workspace\\cc-bro\\test\\fixtures'
  ])
  const exists = p => existing.has(p.replace(/[\\/]+$/, '').toLowerCase())

  const cleaned = sanitizeSetupPath(raw, {
    nodeDir: 'C:\\Program Files\\nodejs',
    isIsolated: false,
    platform: 'win32',
    exists
  })
  assert.deepEqual(cleaned.split(';'), [
    'C:\\Program Files\\nodejs',
    'C:\\Users\\alice\\AppData\\Roaming\\npm',
    'D:\\Tools\\Git\\cmd',
    '\\\\fileserver\\share\\bin'
  ])
})

test('parseCmdNodeShim parses npm 12.0.2, pnpm/yarn, and simple Node shims and returns null for non-Node wrappers', () => {
  const npm12PiCmd = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*'
  ].join('\r\n')

  const parsedNpm12 = parseCmdNodeShim(npm12PiCmd, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\pi.cmd')
  assert.ok(parsedNpm12)
  assert.equal(parsedNpm12.script, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js')
  assert.deepEqual(parsedNpm12.nodeArgs, [])
  assert.deepEqual(parsedNpm12.prefixArgs, [])

  const simpleShim = '@echo off\r\nnode "%~dp0\\codex.mjs" %*\r\n'
  const parsedSimple = parseCmdNodeShim(simpleShim, 'C:\\Tools\\bin\\codex.cmd')
  assert.ok(parsedSimple)
  assert.equal(parsedSimple.script, 'C:\\Tools\\bin\\codex.mjs')

  const customWrapper = [
    '@echo off',
    'set "CUSTOM_ENDPOINT=http://127.0.0.1:8888"',
    'call "%APPDATA%\\npm\\pi.cmd" %*'
  ].join('\r\n')
  assert.equal(parseCmdNodeShim(customWrapper, 'C:\\Users\\alice\\AppData\\Local\\custom\\pi.cmd'), null)

  const cursorPsWrapper = [
    '@echo off',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*'
  ].join('\r\n')
  assert.equal(parseCmdNodeShim(cursorPsWrapper, 'C:\\Users\\alice\\AppData\\Local\\cursor-agent\\cursor-agent.cmd'), null)
})

test('resolveCli and resolveCommand follow Windows PATHEXT, skip extensionless POSIX shims, unwrap Node shims, and fallback to ComSpec', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'broco-win-resolve-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(join(dir, 'pi'), '#!/bin/sh\necho posix\n')
  mkdirSync(join(dir, 'node_modules', '@demo', 'pi'), { recursive: true })
  const targetScript = join(dir, 'node_modules', '@demo', 'pi', 'cli.js')
  writeFileSync(targetScript, 'console.log("ok")\n')
  writeFileSync(
    join(dir, 'pi.cmd'),
    '@ECHO off\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@demo\\pi\\cli.js" %*\r\n'
  )

  writeFileSync(join(dir, 'cursor-agent.cmd'), '@echo off\r\npowershell.exe -NoProfile -File "%~dp0cursor-agent.ps1" %*\r\n')
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\necho cmd\r\n')

  assert.equal(resolveCli('pi', { dirs: [dir], platform: 'win32' }), join(dir, 'pi.cmd'))
  assert.equal(resolveCli('tool', { dirs: [dir], platform: 'win32' }), join(dir, 'tool.exe'))
  assert.deepEqual(pathextList({ PATHEXT: '.EXE;.CMD' }), ['.exe', '.cmd'])

  const resolvedNode = resolveCommand('pi', ['--mode', 'rpc'], {
    dirs: [dir],
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    checkScriptExists: false
  })
  assert.equal(resolvedNode.file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(resolvedNode.shell, false)
  assert.equal(resolvedNode.args.at(-2), '--mode')
  assert.equal(resolvedNode.args.at(-1), 'rpc')

  const resolvedWrapper = resolveCommand('cursor-agent', ['--version'], {
    dirs: [dir],
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  })
  assert.equal(resolvedWrapper.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(resolvedWrapper.shell, false)
  assert.equal(resolvedWrapper.windowsVerbatimArguments, true)
  assert.deepEqual(resolvedWrapper.args.slice(0, 3), ['/d', '/s', '/c'])

  const normalized = normalizeEnv({ Path: 'C:\\Windows', PATH: 'C:\\Tools', CUSTOM: '1' }, 'win32')
  assert.equal(getEnvVar(normalized, 'path'), 'C:\\Tools')
})

test('setupInfo generates broco.cmd on win32, uses NTFS junction for Pi, and falls back to copying SKILL.md on EPERM', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'broco-win-setup-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const homeJunction = join(root, 'home-junction')
  mkdirSync(join(homeJunction, '.pi', 'agent'), { recursive: true })
  const linkCalls = []
  const info = setupInfo({
    homeDir: homeJunction,
    env: { PATH: 'C:\\Users\\alice\\AppData\\Local\\Temp\\bad;C:\\Tools' },
    platform: 'win32',
    symlinkImpl: (target, path, type) => {
      linkCalls.push({ target, path, type })
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'SKILL.md'), readFileSync(join(target, 'SKILL.md'), 'utf8'))
    }
  })

  assert.equal(info.launcher, join(homeJunction, '.agents', 'skills', 'broco', 'broco.cmd'))
  assert.equal(existsSync(info.launcher), true)
  const cmdContent = readFileSync(info.launcher, 'utf8')
  assert.ok(cmdContent.includes('\r\n'))
  assert.ok(cmdContent.startsWith('@echo off\r\nsetlocal\r\n'))
  assert.match(cmdContent, /set "PATH=.*;%PATH%"/)
  assert.match(cmdContent, /if "%BROCO_HOME%"=="" set "BROCO_HOME=/)
  assert.match(cmdContent, /"[^"]+" "[^"]+" %\*/)
  assert.doesNotMatch(cmdContent, /Temp\\bad/i)

  const skillContent = readFileSync(info.skillPath, 'utf8')
  assert.ok(skillContent.includes('"' + info.launcher + '"'))

  assert.equal(linkCalls.length, 1)
  assert.equal(linkCalls[0].type, 'junction')
  assert.equal(linkCalls[0].target, join(homeJunction, '.agents', 'skills', 'broco'))
  assert.equal(linkCalls[0].path, join(homeJunction, '.pi', 'agent', 'skills', 'broco'))
  assert.ok(info.hosts.some(h => h.id === 'pi' && !h.fallbackCopy))

  const homeFallback = join(root, 'home-fallback')
  mkdirSync(join(homeFallback, '.pi', 'agent'), { recursive: true })
  const fallbackInfo = setupInfo({
    homeDir: homeFallback,
    env: { PATH: 'C:\\Tools' },
    platform: 'win32',
    symlinkImpl: () => {
      const err = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    }
  })
  const piHost = fallbackInfo.hosts.find(h => h.id === 'pi')
  assert.ok(piHost)
  assert.equal(piHost.fallbackCopy, true)
  assert.equal(existsSync(piHost.skillPath), true)
  assert.equal(lstatSync(piHost.dir).isDirectory(), true)
  assert.ok(readFileSync(piHost.skillPath, 'utf8').includes('"' + fallbackInfo.launcher + '"'))
})

test('socketFor produces Windows Named Pipes on win32 and deterministic socket paths on POSIX', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'broco-win-sock-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const sock = socketFor(dir)
  if (process.platform === 'win32') {
    assert.match(sock, /^\\\\\.\\pipe\\broco-[0-9a-f]{24}$/)
    assert.equal(socketFor(dir.toUpperCase()), socketFor(dir.toLowerCase()))
    assert.equal(samePath('C:\\Users\\Alice', 'c:\\users\\alice'), true)
    assert.equal(isWithinPath('C:\\Users\\Alice\\Repo', 'c:\\users\\alice'), true)
  } else {
    assert.match(sock, /s-[0-9a-f]{24}\.sock$/)
    assert.equal(socketFor(dir), sock)
    assert.equal(samePath(dir, dir), true)
    assert.equal(isWithinPath(join(dir, 'sub'), dir), true)
  }
})
