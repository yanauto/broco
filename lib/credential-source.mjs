import { execFile } from 'node:child_process'
import { validateHeaderValue } from 'node:http'
import { promisify } from 'node:util'
import { getEnvVar } from './spawn-cli.mjs'

const exec = promisify(execFile)

export async function credentialValue(opt) {
  if (Boolean(opt['value-env']) === Boolean(opt['value-command'])) throw new Error('Choose exactly one of --value-env or --value-command')
  let value
  if (opt['value-env']) {
    value = process.env[opt['value-env']]
    delete process.env[opt['value-env']]
  } else {
    try {
      const result = process.platform === 'win32'
        ? await exec(getEnvVar(process.env, 'ComSpec') || 'cmd.exe', ['/d', '/s', '/c', '"' + opt['value-command'] + '"'], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true, windowsVerbatimArguments: true })
        : await exec('/bin/sh', ['-c', opt['value-command']], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384 })
      value = result.stdout.replace(/[\r\n]+$/, '')
    } catch { throw new Error('Credential command failed (output withheld)') }
  }
  if (!value) throw new Error('Credential source returned an empty value')
  try { validateHeaderValue('credential', (opt['value-prefix'] || '') + value) }
  catch { throw new Error('Credential source returned an invalid header value (output withheld)') }
  return value
}
