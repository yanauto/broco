import { createRealApi } from './api.js'

export const api = createRealApi()

const ROSTER_TTL_MS = 45000

function safeDecode(text) {
  try { return decodeURIComponent(text) } catch { return text }
}

function parseRoute() {
  const h = safeDecode(location.hash.slice(1))
  if (h.startsWith('settings-')) return { name: 'settings', id: h.slice(9) || 'global' }
  if (h.startsWith('p-')) return { name: 'board', id: h.slice(2) }
  return { name: 'home' }
}

function initialTheme() {
  try {
    if (typeof document !== 'undefined') {
      const attr = document.documentElement.dataset.theme
      if (attr === 'light' || attr === 'dark') return attr
    }
    if (typeof window !== 'undefined') {
      const saved = window.localStorage?.getItem('broco-theme')
      if (saved === 'light' || saved === 'dark') return saved
    }
  } catch {}
  return 'dark'
}

export const app = $state({
  route: parseRoute(),
  theme: initialTheme(),
  projects: [],
  projectsLoaded: false,
  tickets: {},
  ticketsLoaded: {},
  batches: {},
  roster: null,
  rosterLoading: false,
  rosterLoadedAt: 0,
  connected: true,
  everConnected: false,
  connectionFailed: false,
  pendingReconnect: false,
  toast: null,
  now: Date.now(),
  settingsTick: 0,
  reconnectTick: 0
})

export function setTheme(mode) {
  const next = mode === 'light' ? 'light' : 'dark'
  app.theme = next
  try {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = next
    if (typeof window !== 'undefined') window.localStorage?.setItem('broco-theme', next)
  } catch {}
}

export function toggleTheme() {
  setTheme(app.theme === 'dark' ? 'light' : 'dark')
}

let toastTimer = null
export function toast(message, kind = 'info') {
  app.toast = { message, kind, id: Math.random() }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { app.toast = null }, kind === 'error' ? 6000 : 3200)
}

export async function copyText(text, successMessage) {
  const val = String(text ?? '')
  if (!val) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(val)
    } else {
      const el = document.createElement('textarea')
      el.value = val
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    if (successMessage) toast(successMessage)
    return true
  } catch {
    return false
  }
}

export function go(hash) {
  if (location.hash.slice(1) === hash) return
  location.hash = hash ? hash : ''
  if (!hash) history.replaceState(null, '', location.pathname)
  app.route = parseRoute()
}

export function projectHash(id) {
  return 'p-' + encodeURIComponent(id)
}

export function settingsHash(scope) {
  return 'settings-' + encodeURIComponent(scope || 'global')
}

let rosterInflight = null
export async function loadGlobalRoster(force = false) {
  const fresh = !force && app.roster && (Date.now() - app.rosterLoadedAt < ROSTER_TTL_MS)
  if (fresh) return app.roster
  if (rosterInflight && !force) return rosterInflight
  app.rosterLoading = true
  rosterInflight = api.getRoster('global', force)
    .then(data => {
      app.roster = data
      app.rosterLoadedAt = Date.now()
      return data
    })
    .catch(() => app.roster)
    .finally(() => {
      app.rosterLoading = false
      rosterInflight = null
    })
  return rosterInflight
}

function upsertProject(p) {
  const i = app.projects.findIndex(x => x.id === p.id)
  if (i >= 0) app.projects[i] = p
  else app.projects.unshift(p)
}

const batchRefreshTimers = new Map()
function maybeRefreshBatches(pid, ticketsToCheck) {
  const known = new Set((app.batches[pid] || []).map(b => b.prefix))
  let missing = false
  for (const t of ticketsToCheck) {
    if (t?.batch?.prefix && !known.has(t.batch.prefix)) {
      missing = true
      break
    }
    if (!t?.batch && typeof t?.title === 'string' && /\[\d+\/\d+\]$/.test(t.title) && typeof t?.id === 'string') {
      const m = /^(.+)-\d+$/.exec(t.id)
      if (m && !known.has(m[1])) {
        missing = true
        break
      }
    }
  }
  if (!missing || batchRefreshTimers.has(pid)) return
  batchRefreshTimers.set(pid, setTimeout(() => {
    batchRefreshTimers.delete(pid)
    loadBatches(pid)
  }, 250))
}

function upsertTicket(pid, t) {
  if (!app.tickets[pid]) return
  const list = app.tickets[pid]
  const i = list.findIndex(x => x.id === t.id)
  if (i >= 0) list[i] = t
  else list.push(t)
  maybeRefreshBatches(pid, [t])
}

function purgeProjectState(pid) {
  app.projects = app.projects.filter(p => p.id !== pid)
  delete app.tickets[pid]
  delete app.ticketsLoaded[pid]
  delete app.batches[pid]
  const timer = batchRefreshTimers.get(pid)
  if (timer) {
    clearTimeout(timer)
    batchRefreshTimers.delete(pid)
  }
  if (app.route.name === 'board' && app.route.id === pid) go('')
  else if (app.route.name === 'settings' && app.route.id === pid) go('settings-global')
}

function handle(msg) {
  switch (msg.type) {
    case 'hello': {
      const wasOffline = app.pendingReconnect
      app.pendingReconnect = false
      app.connected = true
      app.everConnected = true
      app.connectionFailed = false
      app.projects = msg.projects
      app.projectsLoaded = true
      if (app.route.name === 'board') {
        if (msg.projects.some(p => p.id === app.route.id)) {
          loadTickets(app.route.id)
          loadBatches(app.route.id)
        } else {
          go('')
        }
      } else if (app.route.name === 'settings' && app.route.id !== 'global' && !msg.projects.some(p => p.id === app.route.id)) {
        go('settings-global')
      }
      if (wasOffline) {
        app.reconnectTick++
        loadGlobalRoster(false)
      }
      break
    }
    case 'project':
      upsertProject(msg.project)
      break
    case 'project-removed':
      purgeProjectState(msg.projectId)
      break
    case 'ticket':
      upsertTicket(msg.projectId, msg.ticket)
      break
    case 'tickets':
      if (app.tickets[msg.projectId] || (app.route.name === 'board' && app.route.id === msg.projectId)) {
        app.tickets[msg.projectId] = msg.tickets
        app.ticketsLoaded[msg.projectId] = true
        maybeRefreshBatches(msg.projectId, msg.tickets)
      }
      break
    case 'batch':
      if (msg.projectId && msg.batch) {
        const list = app.batches[msg.projectId] || []
        const i = list.findIndex(b => b.prefix === msg.batch.prefix)
        if (i >= 0) list[i] = msg.batch
        else list.push(msg.batch)
        app.batches[msg.projectId] = list
      }
      break
    case 'settings':
      app.settingsTick++
      loadGlobalRoster(true)
      break
  }
}

export async function loadProjects() {
  try {
    app.projects = await api.listProjects()
    app.projectsLoaded = true
  } catch (e) {
    toast(e.message, 'error')
  }
}

export async function loadBatches(pid) {
  try {
    app.batches[pid] = await api.listBatches(pid)
  } catch {
    app.batches[pid] = app.batches[pid] || []
  }
}

export async function loadTickets(pid) {
  try {
    app.tickets[pid] = await api.listTickets(pid)
    app.ticketsLoaded[pid] = true
  } catch (e) {
    if (e.status === 404 || e.code === 'PROJECT_NOT_FOUND' || /^Unknown project\b/i.test(e.message || '')) {
      purgeProjectState(pid)
      toast(e.message, 'error')
      return
    }
    app.ticketsLoaded[pid] = true
    app.tickets[pid] = app.tickets[pid] || []
    toast(e.message, 'error')
  }
}

let started = false
export function start() {
  if (started) return
  started = true
  setTheme(app.theme)
  loadGlobalRoster(false)
  const onHash = () => {
    app.route = parseRoute()
    if (app.route.name === 'board') {
      if (!app.tickets[app.route.id]) loadTickets(app.route.id)
      if (!app.batches[app.route.id]) loadBatches(app.route.id)
    }
  }
  const onVisibility = () => {
    if (!document.hidden) {
      app.now = Date.now()
      loadGlobalRoster(false)
    }
  }
  addEventListener('hashchange', onHash)
  document.addEventListener('visibilitychange', onVisibility)
  const tickTimer = setInterval(() => {
    if (!document.hidden) app.now = Date.now()
  }, 1000)
  const rosterTimer = setInterval(() => {
    if (!document.hidden) loadGlobalRoster(false)
  }, ROSTER_TTL_MS)
  const fallbackTimer = setTimeout(() => {
    if (!app.projectsLoaded) {
      loadProjects()
      if (app.route.name === 'board') {
        loadTickets(app.route.id)
        loadBatches(app.route.id)
      }
    }
  }, 1200)
  const unsubscribe = api.subscribe(handle, ok => {
    if (!ok) {
      app.connected = false
      app.connectionFailed = true
      app.pendingReconnect = true
    } else {
      app.connected = true
      app.everConnected = true
      app.connectionFailed = false
    }
  })
  return () => {
    started = false
    removeEventListener('hashchange', onHash)
    document.removeEventListener('visibilitychange', onVisibility)
    clearInterval(tickTimer)
    clearInterval(rosterTimer)
    clearTimeout(fallbackTimer)
    unsubscribe()
  }
}
