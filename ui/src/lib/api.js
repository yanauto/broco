export async function request(method, path, body, signal) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) {
    const err = new Error(data?.error?.message || `${res.status} ${res.statusText}`)
    err.code = data?.error?.code
    err.status = res.status
    throw err
  }
  return data
}

export function createRealApi() {
  return {
    listProjects: () => request('GET', '/api/projects'),
    listTickets: id => request('GET', `/api/projects/${encodeURIComponent(id)}/tickets`),
    getTicket: (id, tid, signal) => request('GET', `/api/projects/${encodeURIComponent(id)}/tickets/${encodeURIComponent(tid)}`, undefined, signal),
    listBatches: id => request('GET', `/api/projects/${encodeURIComponent(id)}/batches`),
    getBatch: (id, prefix) => request('GET', `/api/projects/${encodeURIComponent(id)}/batches/${encodeURIComponent(prefix)}`),
    getRoster: (scope = 'global', refresh = false) => request('GET', `/api/roster/${encodeURIComponent(scope)}${refresh ? '?refresh=1' : ''}`),
    subscribe(onMessage, onStatus) {
      const source = new EventSource('/api/stream')
      source.onmessage = e => {
        try { onMessage(JSON.parse(e.data)) } catch {}
      }
      source.onopen = () => onStatus(true)
      source.onerror = () => onStatus(false)
      return () => source.close()
    }
  }
}
