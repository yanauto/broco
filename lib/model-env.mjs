import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage()
const reserved = /^(?:BROCO_(?:HOME|PORT|CONCURRENCY|MARKER|BASH_ENV|TZ|IN_WORKER|API_KEY|FORCE_LAUNCHD)|CC_BRO_(?:HOME|PORT|CONCURRENCY|MARKER|BASH_ENV)|PI_(?:CODING_AGENT_.*|OFFLINE|TELEMETRY)|GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR)|NPM_CONFIG_PREFIX|npm_config_prefix|CLAUDECODE|NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*|BASH_ENV|ENV|PATH|HOME|TMPDIR|PWD|OLDPWD|SHELL|SHLVL|TZ|_)$/

export function modelVariables(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => /^[A-Za-z_]\w*$/.test(key) && !reserved.test(key) && typeof value === 'string'))
}

export function withModelEnvironment(env, run) { return current.run(modelVariables(env ?? {}), run) }
export function modelEnvironment() { return { ...process.env, ...current.getStore() } }
