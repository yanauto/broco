function validLimit(n) {
  return Number.isSafeInteger(n) && n >= 1
}

export class Slots {
  constructor(defaultLimit = 3) {
    if (!validLimit(defaultLimit)) throw new Error('BROCO_CONCURRENCY must be a positive integer')
    this.defaultLimit = defaultLimit
    this.limits = new Map()
    this.pools = new Map()
    this.paused = false
    this.suppressNotify = false
    this.dirtyPools = new Set()
    this.notifyScheduled = false
  }

  get limit() {
    return this.defaultLimit
  }

  set limit(n) {
    if (!validLimit(n)) throw new Error('BROCO_CONCURRENCY must be a positive integer')
    this.defaultLimit = n
  }

  scopeOf(crew) {
    return crew?.workerSettings?.()?.id || crew?.projectId || 'default'
  }

  pool(scope, crew) {
    let p = this.pools.get(scope)
    if (!p) {
      p = { active: new Map(), queue: new Map(), crew: null }
      this.pools.set(scope, p)
    }
    if (crew) p.crew = crew
    return p
  }

  limitFor(scope = 'default', crew = this.pools.get(scope)?.crew) {
    const configured = crew?.workerSettings?.()?.concurrency
    if (validLimit(configured)) return configured
    const override = this.limits.get(scope)
    if (validLimit(override)) return override
    return this.defaultLimit
  }

  setLimit(scope, n) {
    const key = !scope || scope === 'global' || scope === 'default' ? 'default' : scope
    if (n === null) {
      if (key !== 'default') this.limits.delete(key)
    } else {
      if (!validLimit(n)) throw new Error('BROCO_CONCURRENCY must be a positive integer')
      if (key === 'default') this.defaultLimit = n
      else this.limits.set(key, n)
    }
    for (const [poolScope, p] of this.pools) {
      if (key === 'default' || poolScope === key) p.crew?.syncConcurrency?.(this.limitFor(poolScope, p.crew))
    }
    this.drain()
    return this.limitFor(key)
  }

  queueInfo(cid) {
    for (const [scope, p] of this.pools) {
      if (!p.queue.has(cid)) continue
      const ids = [...p.queue.keys()]
      const crew = p.queue.get(cid)?.crew ?? p.crew
      return {
        position: ids.indexOf(cid) + 1,
        totalQueued: ids.length,
        limit: this.limitFor(scope, crew),
        scope,
        activeNames: [...p.active.values()].map(a => a.name)
      }
    }
    return null
  }

  scheduleNotify() {
    if (this.notifyScheduled || !this.dirtyPools.size) return
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      if (this.suppressNotify) return
      const pools = [...this.dirtyPools]
      this.dirtyPools.clear()
      for (const p of pools) {
        for (const [id, item] of p.queue) item.crew?.onQueueChange?.(id)
      }
    })
  }

  notifyQueue(p) {
    this.dirtyPools.add(p)
    if (!this.suppressNotify) this.scheduleNotify()
  }

  flushNotifications() {
    this.suppressNotify = false
    this.scheduleNotify()
  }

  reserve(crew, c) {
    const scope = this.scopeOf(crew)
    const p = this.pool(scope, crew)
    const limit = this.limitFor(scope, crew)
    crew?.syncConcurrency?.(limit)
    if (!this.paused && p.queue.size && p.active.size < limit) this.drainPool(scope, p)
    if (!this.paused && p.active.size < limit && !p.queue.size) {
      p.active.set(c.id, { scope, crew, name: c.name, turn: c.turn, startedAt: Date.now() })
      return true
    }
    const existing = p.queue.get(c.id)
    p.queue.set(c.id, { scope, crew, name: c.name, turn: c.turn, queuedAt: existing?.queuedAt ?? Date.now() })
    this.notifyQueue(p)
    return false
  }

  release(id, turn) {
    let changed = false
    for (const p of this.pools.values()) {
      const activeItem = p.active.get(id)
      if (activeItem && (turn === undefined || activeItem.turn === turn)) {
        p.active.delete(id)
        changed = true
      }
      const queuedItem = p.queue.get(id)
      if (queuedItem && (turn === undefined || queuedItem.turn === turn)) {
        p.queue.delete(id)
        queuedItem.crew?.clearEnvFor?.(id, turn)
        changed = true
        this.notifyQueue(p)
      }
    }
    this.drain()
    return changed
  }

  drainPool(scope, p) {
    if (!p.queue.size || this.paused) return
    let cachedCrew = p.crew
    let limit = this.limitFor(scope, cachedCrew)
    cachedCrew?.syncConcurrency?.(limit)
    for (const [id, item] of p.queue) {
      const { crew, name, turn } = item
      if (crew !== cachedCrew) {
        cachedCrew = crew
        limit = this.limitFor(scope, crew)
        crew?.syncConcurrency?.(limit)
      }
      if (this.paused || p.active.size >= limit) break
      p.queue.delete(id)
      if (crew.closing) {
        crew?.clearEnvFor?.(id, turn)
        continue
      }
      p.active.set(id, { scope, crew, name, turn, startedAt: Date.now() })
      crew.serial(name, async () => {
        const c = crew.store.byName(name)
        if (!crew.closing && c && c.turn === turn && c.status === 'queued') await crew.dispatch(c)
        else {
          crew?.clearEnvFor?.(id, turn)
          this.release(id, turn)
        }
      }).catch(() => {
        this.release(id, turn)
      })
    }
    if (p.queue.size) this.notifyQueue(p)
  }

  drain() {
    if (this.paused) return
    for (const [scope, p] of this.pools) this.drainPool(scope, p)
  }
}
