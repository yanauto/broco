<script>
  import { flip } from 'svelte/animate'
  import { crossfade, fade, scale } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { app, go, loadBatches, loadTickets } from '../lib/store.svelte.js'
  import { t, tf } from '../lib/i18n.svelte.js'
  import { isLiveWorking, shortPath } from '../lib/format.js'
  import Icon from './Icon.svelte'
  import SegMeter from './SegMeter.svelte'
  import TicketCard from './TicketCard.svelte'
  import Drawer from './Drawer.svelte'

  let { id } = $props()

  const cols = ['queued', 'working', 'review', 'done']
  const COL_CAP = 50

  const [send, receive] = crossfade({
    duration: d => Math.min(440, Math.sqrt(d) * 20),
    easing: cubicOut,
    fallback: node => scale(node, { start: 0.96, duration: 150, opacity: 0 })
  })

  const ascIso = (a, b) => (a > b ? 1 : a < b ? -1 : 0)
  const descIso = (a, b) => (b > a ? 1 : b < a ? -1 : 0)

  const order = {
    queued: (a, b) => ascIso(a.createdAt || '', b.createdAt || ''),
    working: (a, b) => ascIso(a.startedAt || a.updatedAt || '', b.startedAt || b.updatedAt || ''),
    review: (a, b) => {
      const af = a.flag ? 1 : 0
      const bf = b.flag ? 1 : 0
      if (af !== bf) return bf - af
      return ascIso(a.updatedAt || '', b.updatedAt || '')
    },
    done: (a, b) => descIso(a.updatedAt || '', b.updatedAt || '')
  }

  let project = $derived(app.projects.find(p => p.id === id))
  let tickets = $derived(app.tickets[id] || [])
  let rawBatches = $derived(app.batches[id] || [])
  let loaded = $derived(!!app.ticketsLoaded[id])

  let selected = $state(new URLSearchParams(location.search).get('ticket'))
  let hoveredTicketId = $state(null)
  let query = $state('')
  let statusFilter = $state('all')
  let batchFilter = $state('')
  let showAllCols = $state({})

  let running = $derived(tickets.reduce((n, x) => n + (isLiveWorking(x) ? 1 : 0), 0))
  let limit = $derived(project?.concurrency ?? 3)

  let linkedTicketIds = $derived.by(() => {
    const out = new Set()
    if (!hoveredTicketId) return out
    const target = tickets.find(x => x.id === hoveredTicketId)
    if (target) {
      if (target.parent) out.add(target.parent)
      for (const r of target.reviews || []) {
        if (r?.id) out.add(r.id)
      }
    }
    for (const x of tickets) {
      if (x.id === hoveredTicketId) continue
      if (x.parent === hoveredTicketId) out.add(x.id)
      if (x.reviews?.some(r => r.id === hoveredTicketId)) out.add(x.id)
    }
    if (out.size > 0) out.add(hoveredTicketId)
    return out
  })

  let shardLookup = $derived.by(() => {
    const map = new Map()
    for (const b of rawBatches) {
      const count = b.count || b.shards?.length || 0
      for (const s of b.shards || []) {
        map.set(s.name, { prefix: b.prefix, index: s.index, count, input: s.input })
      }
    }
    for (const x of tickets) {
      if (x.batch?.prefix && !map.has(x.id)) map.set(x.id, x.batch)
    }
    return map
  })

  function batchSegments(b, cells = 10) {
    const total = Math.max(1, b.count || 0)
    const buckets = [
      { tone: 'err', n: b.error || 0 },
      { tone: 'working', n: b.working || 0 },
      { tone: 'warn', n: b.review || 0 },
      { tone: 'done', n: b.done || 0 }
    ]
    const out = []
    for (const bucket of buckets) {
      if (bucket.n <= 0) continue
      const slots = Math.max(1, Math.round((bucket.n / total) * cells))
      for (let i = 0; i < slots && out.length < cells; i++) out.push(bucket.tone)
    }
    while (out.length < cells) out.push(null)
    return out
  }

  let batches = $derived.by(() => {
    const byTicket = new Map(tickets.map(x => [x.id, x]))
    const groups = new Map()
    for (const b of rawBatches) {
      groups.set(b.prefix, {
        prefix: b.prefix,
        title: b.title || b.prefix,
        brief: b.brief || '',
        createdAt: b.createdAt ?? null,
        createdLocal: b.createdLocal ?? b.createdAsia ?? null,
        count: b.count || b.shards?.length || 0,
        shardNames: (b.shards || []).map(s => ({ name: s.name, index: s.index, input: s.input }))
      })
    }
    for (const x of tickets) {
      if (!x.batch?.prefix) continue
      let g = groups.get(x.batch.prefix)
      if (!g) {
        g = { prefix: x.batch.prefix, title: x.batch.prefix, brief: '', count: x.batch.count || 0, shardNames: [] }
        groups.set(x.batch.prefix, g)
      }
      if (!g.shardNames.some(s => s.name === x.id)) {
        g.shardNames.push({ name: x.id, index: x.batch.index, input: x.batch.input })
      }
      if (x.batch.count > g.count) g.count = x.batch.count
    }
    return [...groups.values()].map(g => {
      let done = 0, review = 0, working = 0, queued = 0, error = 0, stopped = 0
      const sortedShards = [...g.shardNames].sort((a, b) => a.index - b.index).map(s => {
        const tk = byTicket.get(s.name)
        let st = 'queued'
        if (tk) {
          if (tk.status === 'done') { st = 'done'; done++ }
          else if (tk.flag === 'error') { st = 'error'; error++ }
          else if (tk.flag === 'stopped') { st = 'stopped'; stopped++ }
          else if (tk.status === 'working') { st = 'working'; working++ }
          else if (tk.status === 'review') { st = 'review'; review++ }
          else { st = 'queued'; queued++ }
        } else {
          queued++
        }
        return { ...s, status: st, outcome: tk?.outcome ?? null }
      })
      const count = Math.max(g.count, sortedShards.length)
      return { ...g, count, done, review, working, queued, error, stopped, shards: sortedShards }
    })
  })

  let hasActiveFilters = $derived(Boolean(query.trim() || statusFilter !== 'all' || batchFilter))

  let filteredTickets = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return tickets.filter(x => {
      const b = x.batch ?? shardLookup.get(x.id)
      if (batchFilter && b?.prefix !== batchFilter) return false
      if (statusFilter === 'flagged') {
        if (!x.flag && x.status !== 'review') return false
      } else if (statusFilter !== 'all') {
        if (x.outcome !== statusFilter) return false
      }
      if (q) {
        const hay = `${x.id} ${x.title || ''} ${x.provider || ''} ${x.model || ''} ${x.branch || ''} ${b?.prefix || ''} ${b?.input || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  })

  let animateCards = $derived(filteredTickets.length <= 40)

  let columns = $derived.by(() => {
    const grouped = { queued: [], working: [], review: [], done: [] }
    for (const x of filteredTickets) {
      if (grouped[x.status]) grouped[x.status].push(x)
    }
    for (const c of cols) grouped[c].sort(order[c])
    return grouped
  })

  let colsTemplate = $derived(
    cols.map(c => (columns[c].length === 0 ? 'minmax(136px, 0.45fr)' : 'minmax(280px, 1.35fr)')).join(' ')
  )

  let allClearResting = $derived(
    loaded &&
    tickets.length > 0 &&
    !hasActiveFilters &&
    columns.queued.length === 0 &&
    columns.working.length === 0 &&
    columns.review.length === 0 &&
    columns.done.length > 0
  )

  let selectedBatchDetail = $derived.by(() => {
    if (!selected) return null
    const tk = tickets.find(x => x.id === selected)
    const b = tk?.batch ?? shardLookup.get(selected)
    if (!b?.prefix) return null
    const group = batches.find(g => g.prefix === b.prefix)
    return {
      ...b,
      brief: group?.brief || '',
      createdAt: group?.createdAt ?? null,
      createdLocal: group?.createdLocal ?? null,
      shards: group?.shards || []
    }
  })

  function resetFilters() {
    query = ''
    statusFilter = 'all'
    batchFilter = ''
  }

  $effect(() => {
    if (!app.tickets[id]) loadTickets(id)
    if (!app.batches[id]) loadBatches(id)
  })
</script>

<section class="board">
  <div class="bar">
    <div class="who">
      <button class="icon-btn" onclick={() => go('')} title={t('back')} aria-label={t('back')}>
        <Icon name="back" size={16} />
      </button>
      <div class="meta">
        <div class="title-row">
          <h1>{project?.name ?? id}</h1>
          <span class="chip" class:working={running > 0}>
            {running > 0 ? tf('slotsLoad', { running, limit }) : tf('concurrencyShort', { limit })}
          </span>
          {#if project?.worker}
            <span class="chip mono">{project.worker}</span>
          {/if}
        </div>
        {#if project}<div class="path mono" title={project.repoPath}>{shortPath(project.repoPath)}</div>{/if}
      </div>
    </div>

    <div class="tools">
      <label class="search-box">
        <Icon name="search" size={13} />
        <input type="search" bind:value={query} placeholder={t('searchPlaceholder')} />
      </label>

      <select class="filter-select" bind:value={statusFilter} aria-label={t('outcome')}>
        <option value="all">{t('filterAll')}</option>
        <option value="flagged">{t('filterFlagged')}</option>
        <option value="pass">{t('filterPass')}</option>
        <option value="rework">{t('filterRework')}</option>
        <option value="fail">{t('filterFail')}</option>
        <option value="blocked">{t('filterBlocked')}</option>
      </select>

      {#if hasActiveFilters}
        <button class="btn btn-ghost sm-btn" onclick={resetFilters}>{t('clearFilters')}</button>
      {/if}
    </div>
  </div>

  {#if batches.length > 0}
    <div class="batches-bar">
      <span class="batches-label mono">{t('batches')}</span>
      <button
        class="batch-pill"
        class:active={!batchFilter}
        onclick={() => (batchFilter = '')}
      >
        <span>{t('allTickets')}</span>
        <span class="mono">{tickets.length}</span>
      </button>
      {#each batches as b (b.prefix)}
        {@const settled = b.done + b.review}
        <button
          class="batch-pill"
          class:active={batchFilter === b.prefix}
          class:has-err={b.error > 0}
          onclick={() => (batchFilter = batchFilter === b.prefix ? '' : b.prefix)}
          title={`${b.title} (${settled}/${b.count})`}
        >
          <span class="mono batch-name">{b.prefix}</span>
          <SegMeter segments={batchSegments(b, 10)} size="sm" label={`${settled}/${b.count}`} />
          <span class="mono batch-nums">{settled}/{b.count}</span>
          {#if b.working > 0}
            <span class="dot live-dot pulse"></span>
          {/if}
          {#if b.error > 0}
            <span class="err-count mono">!{b.error}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if loaded && tickets.length === 0}
    <div class="board-empty" in:fade={{ duration: 130 }}>
      <img class="empty-mascot" src="./broco-foreman-256.png" alt="" width="64" height="64" />
      <h2>{t('noTickets')}</h2>
      <p>{t('noTicketsHint')}</p>
    </div>
  {:else}
    {#if loaded && filteredTickets.length === 0 && hasActiveFilters}
      <div class="hint">
        <Icon name="search" size={14} />
        <strong>{t('noMatchingTickets')}</strong>
        <button class="btn btn-ghost sm-btn" onclick={resetFilters}>{t('clearFilters')}</button>
      </div>
    {/if}

    <div class="cols" style="--cols-template: {colsTemplate}">
      {#each cols as c}
        {@const fullList = columns[c]}
        {@const isEmpty = loaded && fullList.length === 0}
        {@const capped = c === 'done' && fullList.length > COL_CAP && !showAllCols[c]}
        {@const visibleList = capped ? fullList.slice(0, COL_CAP) : fullList}
        <div class="col {c}" class:is-empty={isEmpty}>
          <div class="col-head">
            <span class="dot {c}"></span>
            <span class="col-name">{t(c)}</span>
            <span class="col-n num">{fullList.length}</span>
          </div>
          <div class="col-body">
            {#if animateCards}
              {#each visibleList as ticket (ticket.id)}
                <div class="slot" in:receive={{ key: ticket.id }} out:send={{ key: ticket.id }} animate:flip={{ duration: 240, easing: cubicOut }}>
                  <TicketCard
                    {ticket}
                    batch={shardLookup.get(ticket.id) ?? null}
                    selected={selected === ticket.id}
                    linked={linkedTicketIds.has(ticket.id)}
                    onhover={over => (hoveredTicketId = over ? ticket.id : (hoveredTicketId === ticket.id ? null : hoveredTicketId))}
                    onclick={() => (selected = ticket.id)}
                  />
                </div>
              {/each}
            {:else}
              {#each visibleList as ticket (ticket.id)}
                <div class="slot">
                  <TicketCard
                    {ticket}
                    batch={shardLookup.get(ticket.id) ?? null}
                    selected={selected === ticket.id}
                    linked={linkedTicketIds.has(ticket.id)}
                    onhover={over => (hoveredTicketId = over ? ticket.id : (hoveredTicketId === ticket.id ? null : hoveredTicketId))}
                    onclick={() => (selected = ticket.id)}
                  />
                </div>
              {/each}
            {/if}

            {#if fullList.length > COL_CAP && c === 'done'}
              <button class="more-btn" onclick={() => (showAllCols[c] = !showAllCols[c])}>
                {showAllCols[c] ? tf('showLess', { n: COL_CAP }) : tf('showMore', { n: fullList.length })}
              </button>
            {/if}

            {#if isEmpty}
              <div class="empty-rail" aria-hidden="true"><span></span></div>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if allClearResting}
      <div class="resting-bar mono">
        <span class="rest-dot"></span>
        <span>{t('allClear')}</span>
      </div>
    {/if}
  {/if}
</section>

{#if selected}
  <Drawer
    onselect={name => (selected = name)}
    projectId={id}
    ticketId={selected}
    batchInfo={selectedBatchDetail}
    onclose={() => (selected = null)}
  />
{/if}

<style>
  .board {
    flex: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 1520px;
    margin: 0 auto;
    padding: 12px 18px 14px;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .who .icon-btn { margin-left: -4px; }

  .meta { min-width: 0; }

  .title-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.025em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .path {
    font-size: 11.5px;
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
  }

  .search-box {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 9px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .search-box:focus-within {
    border-color: var(--brand-green);
  }
  .search-box input {
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    width: 196px;
    outline: none;
  }

  .filter-select {
    height: 30px;
    padding: 0 9px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
  }

  .sm-btn {
    height: 30px;
    padding: 0 9px;
    font-size: 12px;
  }

  .batches-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 10px;
    overflow-x: auto;
  }

  .batches-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
    white-space: nowrap;
    margin-right: 3px;
  }

  .batch-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 9px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line);
    font-size: 12px;
    white-space: nowrap;
    flex: none;
    transition: background 0.12s, border-color 0.12s;
  }
  .batch-pill:hover { border-color: var(--line-strong); background: var(--surface-raise); }
  .batch-pill.active {
    background: var(--brand-soft);
    border-color: color-mix(in srgb, var(--brand-green) 48%, var(--line));
    color: var(--brand-green);
  }
  .batch-pill.has-err {
    border-color: color-mix(in srgb, var(--status-danger) 48%, var(--line));
  }
  .batch-name { font-weight: 650; font-size: 11.5px; }
  .batch-nums { font-size: 11px; color: var(--muted); }
  .live-dot { width: 6px; height: 6px; background: var(--status-working); }
  .err-count { font-size: 11px; font-weight: 700; color: var(--status-danger); }

  .board-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 48px 24px;
    border-radius: var(--radius-panel);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--card-highlight);
  }

  .empty-mascot {
    width: 64px;
    height: 64px;
    display: block;
    image-rendering: pixelated;
    filter: var(--mascot-outline);
  }

  .board-empty h2 {
    margin: 14px 0 6px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .board-empty p {
    margin: 0;
    max-width: 460px;
    font-size: 13px;
    color: var(--muted);
  }

  .hint {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    margin-bottom: 10px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    color: var(--muted);
    font-size: 12.5px;
  }
  .hint strong { color: var(--ink); font-weight: 600; flex: 1; }

  .cols {
    flex: 1;
    display: grid;
    grid-template-columns: var(--cols-template);
    gap: 10px;
    min-height: 0;
  }

  .col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    border-radius: var(--radius-panel);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    overflow: hidden;
  }

  .col.is-empty {
    background: color-mix(in srgb, var(--surface-recessed) 60%, var(--bg));
    border-color: color-mix(in srgb, var(--line) 70%, transparent);
  }

  .col-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 11px 8px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.01em;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 75%, transparent);
  }

  .col.is-empty .col-head {
    color: var(--faint);
    border-bottom-color: transparent;
  }

  .col-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-n {
    min-width: 20px;
    height: 18px;
    padding: 0 5px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-chip);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }

  .col.is-empty .col-n {
    background: transparent;
    border-color: transparent;
    color: var(--faint);
  }

  .dot.queued { background: var(--faint); }
  .dot.working { background: var(--status-working); }
  .dot.review { background: var(--status-review); }
  .dot.done { background: var(--status-done); }

  .col-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 8px 10px;
    overflow-y: auto;
  }

  .col.done .col-body {
    gap: 5px;
  }

  .empty-rail {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14px;
  }

  .empty-rail span {
    width: 22px;
    height: 2px;
    border-radius: 1px;
    background: var(--line);
    opacity: 0.65;
  }

  .more-btn {
    padding: 7px 10px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    text-align: center;
  }
  .more-btn:hover { color: var(--ink); border-color: var(--line-strong); }

  .resting-bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding-top: 8px;
    font-size: 11.5px;
    color: var(--faint);
  }

  .rest-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-done);
  }

  @media (max-width: 1100px) {
    .cols { overflow-x: auto; grid-template-columns: repeat(4, minmax(250px, 1fr)); padding-bottom: 4px; }
  }

  @media (max-width: 640px) {
    .board { padding: 10px 10px 12px; }
    .search-box input { width: 130px; }
    .cols { grid-template-columns: repeat(4, 84vw); scroll-snap-type: x mandatory; }
    .col { scroll-snap-align: start; }
  }
</style>
