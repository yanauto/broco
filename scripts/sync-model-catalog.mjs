import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modalities } from '../lib/model-catalog.mjs'

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const ts = Date.parse(date + 'T00:00:00Z')
  return Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === date
}

export function validateModelCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') throw new Error('Invalid model catalog')
  if (!validDate(catalog.as_of)) throw new Error('Invalid catalog as_of date: ' + catalog.as_of)
  if (typeof catalog.match_rule !== 'string' || !catalog.match_rule.trim()) throw new Error('Missing catalog match_rule')
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Expected non-empty catalog.models')
  const ids = new Set()
  for (const m of catalog.models) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) throw new Error('Model entry missing id')
    if (ids.has(m.id)) throw new Error('Duplicate model ID: ' + m.id)
    ids.add(m.id)
    if (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.some(a => typeof a !== 'string' || !a.trim()))) {
      throw new Error('Invalid aliases on ' + m.id)
    }
    if (m.modalities != null) {
      if (typeof m.modalities !== 'object') throw new Error('Invalid modalities on ' + m.id)
      if (m.modalities.input !== undefined && (!Array.isArray(m.modalities.input) || m.modalities.input.some(v => !modalities.includes(v)))) {
        throw new Error('Invalid input modalities on ' + m.id)
      }
    }
  }
  if (!catalog.picks || typeof catalog.picks !== 'object' || Array.isArray(catalog.picks)) {
    throw new Error('Missing catalog.picks')
  }
  for (const [category, pick] of Object.entries(catalog.picks)) {
    if (!pick || !Array.isArray(pick.first) || !Array.isArray(pick.backup)) {
      throw new Error('Invalid picks entry for ' + category)
    }
    for (const id of [...pick.first, ...pick.backup]) {
      if (typeof id !== 'string' || !ids.has(id)) {
        throw new Error('Pick ' + category + ' references unknown model ID: ' + id)
      }
    }
  }
  return catalog
}

export function syncModelCatalog(sourcePath = 'docs/models/catalog.json', targetPath = fileURLToPath(new URL('../lib/model-catalog.json', import.meta.url))) {
  const catalogPath = resolve(sourcePath)
  const catalog = validateModelCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')))
  writeFileSync(targetPath, JSON.stringify(catalog, null, 2) + '\n')
  return catalogPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const updatedFrom = syncModelCatalog(process.argv[2] ?? 'docs/models/catalog.json')
  console.log('Updated packaged model catalog from ' + updatedFrom)
}
