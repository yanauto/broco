export function supportedWorker(id) {
  return typeof id === 'string' && /^(codex|claude|agy|cursor-agent|(?:pi|custom):[a-z0-9][a-z0-9_.-]*)$/.test(id)
}

export const chooseAllow = 'Choose allowed workers with --allow codex,claude,pi:<provider>,agy,cursor-agent,custom:<name> (or a single worker)'
export const chooseDefault = 'Choose a default from the allowed workers with --default-worker'
export const AGY_TOS_DOCS_URL = 'https://broco.yanauto.me/docs/workers/#agy'
export const AGY_TOS_WARNING = "Google's consumer plans (Free, AI Plus, Pro, Ultra) do not allow third-party agents to drive the Antigravity CLI; using agy as a broco worker may get the account suspended. Use it only with a Gemini API key or a Gemini Enterprise / Google Cloud project. See " + AGY_TOS_DOCS_URL

export function agyTosWarning() {
  return {
    code: 'agy-tos',
    worker: 'agy',
    message: AGY_TOS_WARNING,
    docs: AGY_TOS_DOCS_URL
  }
}

export function workerPolicy(allow, worker, current) {
  if (allow === undefined && !current?.allow.length) throw new Error(chooseAllow)
  const providers = allow === undefined ? current.allow : [...new Set(allow.split(',').map(v => v.trim()).filter(Boolean))]
  if (!providers.length) throw new Error(chooseAllow)
  if (!providers.every(supportedWorker)) throw new Error('Expected codex, claude, pi:<provider>, agy, cursor-agent or custom:<name>')
  const selected = worker ?? (providers.includes(current?.worker) ? current.worker : providers.length === 1 ? providers[0] : null)
  if (!selected) throw new Error(chooseDefault)
  if (!providers.includes(selected)) throw new Error('Default worker must be allowed')
  return { allow: providers, worker: selected }
}
