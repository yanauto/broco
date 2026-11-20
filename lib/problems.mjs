import { formatShortTime, resolvedTimeZone } from './time.mjs'

export const classes = ['quota', 'region', 'policy', 'network', 'auth', 'context', 'worker']
export const infra = ['quota', 'region', 'policy', 'network', 'auth']

const codexClasses = {
  usageLimitExceeded: 'quota', sessionBudgetExceeded: 'quota', rateLimitExceeded: 'quota',
  cyberPolicy: 'policy', misalignmentPolicyViolation: 'policy',
  serverOverloaded: 'network', internalServerError: 'network', flexUnavailable: 'network',
  httpConnectionFailed: 'network', responseStreamConnectionFailed: 'network', responseStreamDisconnected: 'network', responseTooManyFailedAttempts: 'network',
  unauthorized: 'auth', contextWindowExceeded: 'context'
}

const patterns = [
  ['region', /location is not supported|unsupported[_ ](?:country|region|location)(?:[_ ]territory)?|country,\s*region,\s*or\s*territory\s*not\s*supported|not available in your (?:country|region)/i],
  ['policy', /flagged for possible cybersecurity|content (?:filtering )?(?:policy|was flagged)|safety (?:system|filter)|blocked due to safety|finish_?reason[:=\s]+["']?(?:safety|prohibited_content|blocklist)\b|PROHIBITED_CONTENT|violat\w* (?:our|the) (?:usage )?polic|包含不安全或敏感内容/i],
  ['network', /RESOURCE_EXHAUSTED[\s\S]*?\b(?:no capacity|capacity (?:exhausted|unavailable)|overloaded|high demand)\b|\bno capacity available\b|\bmodel capacity exhausted\b|并发数过高|请求频率过高|\bhigh concurrency\b/i],
  ['quota', /usage limit|(?:5|five)-hour limit|(?:weekly|session) limit(?: reached| exceeded)?|(?:you(?:'ve| have) )?(?:hit|reached) your (?:[\w-]+\s+)?limit\b|rate.?limit(?:ed|[_ ]error| exceeded| reached)|(?:api|usage|token) quota|(?<!disk )quota (?:exceeded|exhausted|reached)|exceeded (?:your|the) (?:current )?quota|insufficient (?:account )?(?:balance|credits?|funds)|credit balance is too low|out of credits|(?:status(?: code)?|HTTP)[ :]{1,2}429\b|429 Too Many|too many requests|RESOURCE_EXHAUSTED|余额不足|无可用资源包/i],
  ['auth', /unauthori[sz]ed|(?:status(?: code)?|HTTP)[ :]{1,2}401\b|401 Unauthori|not (?:logged|signed) in|sign in to this provider|(?:invalid|incorrect)[_ ]api[_ ]key|authentication(?:[_ ]error| (?:failed|required))|pi auth could not resolve|no api-key credential|api-key lookup failed|token (?:has )?expired|please (?:re)?login|please run (?:\/login|claude auth login)|oauth_not_allowed_for_organization|oauth_org_not_allowed|oauth_token_revoked|can't use your claude subscription|invalid_grant|无效的\s*api\s*key|(?:authentication\s*)?token\s*已过期/i],
  ['context', /context (?:window|length|limit)|maximum context|exceeds? (?:the )?maximum (?:number of )?tokens|max_input_tokens|input tokens exceed|too many tokens|(?:prompt|input|conversation) is too long|request_too_large/i],
  ['network', /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|timed out|(?:status(?: code)?|HTTP)[ :]{1,2}(?:50[0234]|529)\b|(?:50[0234]|529) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time|Overloaded)|internal_server_error|overloaded_error|overloaded|service unavailable|stream disconnected/i]
]

export function codexClass(info) {
  if (!info) return null
  const key = typeof info === 'string' ? info : Object.keys(info)[0]
  return codexClasses[key] ?? null
}

export function classify(message, { codex, resetsAt } = {}) {
  const text = String(message ?? '')
  const cls = codexClass(codex) ?? patterns.find(([, re]) => re.test(text))?.[0] ?? 'worker'
  const problem = { class: cls, retryable: ['quota', 'network'].includes(cls), message: text.slice(0, 600) }
  if (resetsAt) problem.resetsAt = new Date(resetsAt * 1000).toISOString()
  return problem
}

export function hint(problem) {
  if (!problem) return null
  const when = problem.resetsAt ? '，' + formatShortTime(problem.resetsAt) + ' (' + resolvedTimeZone() + ') 重置' : ''
  return {
    quota: '额度用尽' + when + '；换一个 bro 派 / quota exhausted; dispatch to another bro',
    region: '供应商按地区拒绝（多半是代理出口）；换 bro 或换出口 / provider rejected the region; switch bro or network exit',
    policy: '被供应商安全过滤拦下；改写措辞后同名续派，或换 bro / blocked by provider safety filter; rephrase and continue, or switch bro',
    network: '网络或服务端故障；稍后同名重试 / network or provider outage; retry the same name later',
    auth: '登录失效；请用户在该 CLI 里重新登录 / signed out; ask the user to log in again in that CLI',
    context: '上下文超限；换新名字开新会话，交代写短 / context window exceeded; start a new name with a shorter brief',
    worker: null
  }[problem.class]
}
