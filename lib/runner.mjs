import { assertSupportedNode, silenceSqliteExperimentalWarning } from './node-runtime.mjs'

assertSupportedNode()
silenceSqliteExperimentalWarning()

await import('./runner-main.mjs')
