import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2), cli = basename(process.argv[1])
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : args.find(s => s.startsWith(flag + '='))?.slice(flag.length + 1) ?? null
const emit = e => console.log(JSON.stringify(e))
if (args.includes('--version')) { console.log(cli === 'claude' ? '2.1.325 (Claude Code)' : 'fixture 1.0'); process.exit() }
if (cli === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  if (existsSync('fixture-signed-out') || existsSync('claude-signed-out')) {
    emit({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
    process.exit(1)
  }
  emit({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', planTier: 'pro' })
  process.exit(0)
}
if (args.includes('status')) { console.log(existsSync('fixture-signed-out') ? 'Not logged in' : 'Logged in'); process.exit() }
if (args.includes('models') || args.includes('--list-models')) {
  console.log(cli === 'agy'
    ? (existsSync('fixture-agy-models.txt') ? readFileSync('fixture-agy-models.txt', 'utf8').trim() : 'fixture-model\tFixture model')
    : 'fixture-model - Fixture model (default)')
  process.exit()
}
if (args.includes('/effort')) { emit({ status: 'SUCCESS', command: { name: 'effort', data: { current: 'low', available: ['low', 'high'] } } }); process.exit() }
if (args.includes('/model')) { emit({ status: 'SUCCESS', command: { name: 'model', data: { id: 'fixture-model' } } }); process.exit() }
if (args.includes('/usage')) {
  const spent = existsSync('agy-quota-spent')
  emit({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: spent ? 0.89 : 0.9, reset_time: '2026-11-24T16:06:25Z' },
              { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: spent ? 0.77 : 0.8, reset_time: '2026-11-17T21:06:25Z' }
            ]
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-24T16:57:37Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-17T21:57:37Z' }
            ]
          }
        ]
      }
    }
  })
  process.exit()
}
let stdinText = ''
if (cli === 'agy') {
  if (args.includes('-p') || args.includes('--print') || args.some(s => s.startsWith('--print='))) {
    console.error('agy turn must pass prompt via stdin, not --print')
    process.exit(2)
  }
  if (value('--input-format') !== 'text' || value('--output-format') !== 'stream-json') {
    console.error('agy expected --input-format text --output-format stream-json')
    process.exit(2)
  }
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) stdinText += chunk
} else if (cli === 'claude') {
  if (!args.includes('-p') && !args.includes('--print')) {
    console.error('claude turn must pass -p/--print')
    process.exit(2)
  }
  if (value('--output-format') !== 'stream-json' || !args.includes('--verbose')) {
    console.error('claude expected --output-format stream-json --verbose')
    process.exit(2)
  }
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) stdinText += chunk
}
const id = value('--conversation') || value('--resume') || randomUUID()
mkdirSync('fixture-sessions', { recursive: true })
const file = join('fixture-sessions', id)
const prompt = (cli === 'agy' || cli === 'claude') ? stdinText : (value('--prompt') ?? args.at(-1))
appendFileSync('worker-args', JSON.stringify(args) + '\n')
let reply = prompt
if (prompt === 'working directory') reply = JSON.stringify({ cwd: process.cwd(), instructions: readFileSync('AGENTS.md', 'utf8'), args })
const code = /Remember the exact code ([a-f0-9-]+)/.exec(prompt)?.[1]
if (code) { writeFileSync(file, code); reply = 'ACK' }
if (prompt.startsWith('remember ')) { writeFileSync(file, prompt.slice(9)); reply = 'ACK' }
if (prompt === 'recall' || prompt.includes('from my previous message')) reply = readFileSync(file, 'utf8')
if (cli === 'agy') emit({ event: 'init', conversation_id: id })
else if (cli === 'cursor-agent' || cli === 'claude') emit({ type: 'system', subtype: 'init', session_id: id, model: value('--model') || 'claude-opus-5-5' })
if (prompt === 'hold') while (!existsSync('release-stream')) await sleep(30)
if (prompt === 'write fixture') writeFileSync('stream-proof.txt', 'proof')
if (prompt === 'spend quota') writeFileSync('agy-quota-spent', '')
if (prompt === 'crash') process.exit(2)
if (cli === 'agy') {
  emit({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 100, cache_read_tokens: 80 } } })
  emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: reply } })
} else if (cli === 'claude') {
  emit({ type: 'assistant', session_id: id, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 } } })
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: reply, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 } })
} else if (cli === 'cursor-agent') {
  emit({ type: 'tool_call', subtype: 'completed', session_id: id })
  emit({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: reply })
} else emit({ id: args.includes('--wrong-id') ? randomUUID() : id, reply })
