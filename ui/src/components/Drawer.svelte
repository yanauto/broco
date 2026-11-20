<script>
  import { fly, fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { app, api, copyText } from '../lib/store.svelte.js'
  import { t, tf, translateActivity } from '../lib/i18n.svelte.js'
  import { ago, clock, compactBranch, compactModel, duration, formatSpent, isLiveWorking, liveElapsed, localTime, pickLocalTime, shortPath, timelineCategory } from '../lib/format.js'
  import { renderMarkdown } from '../lib/markdown.js'
  import Icon from './Icon.svelte'

  let { projectId, ticketId, batchInfo = null, onclose, onselect } = $props()

  let detail = $state(null)
  let failed = $state(null)
  let prevId = ''
  let prevReconnect = app.reconnectTick
  let activeTab = $state('reply')
  let showAllParams = $state(false)
  let copiedKey = $state('')

  let live = $derived((app.tickets[projectId] || []).find(x => x.id === ticketId))
  let currentDetail = $derived(detail?.id === ticketId ? detail : null)
  let ticket = $derived(live ? { ...currentDetail, ...live } : currentDetail)
  let liveWorking = $derived(isLiveWorking(ticket))
  let progress = $derived(currentDetail?.progress ?? null)
  let batch = $derived(batchInfo ?? ticket?.batch ?? null)
  let spentText = $derived(formatSpent(ticket?.quota))
  let signature = $derived(live ? `${live.status}|${live.flag}|${live.turn}|${live.updatedAt}` : '')
  let modelLabel = $derived(ticket ? compactModel(ticket.provider, ticket.model) : '')
  let replyHtml = $derived(currentDetail?.lastReply ? renderMarkdown(currentDetail.lastReply) : '')
  let filesCount = $derived(progress?.changedFilesCount ?? ticket?.changedFiles?.length ?? 0)

  $effect(() => {
    const pid = projectId
    const tid = ticketId
    const sig = signature
    const rec = app.reconnectTick
    const immediate = tid !== prevId || rec !== prevReconnect
    if (tid !== prevId) {
      failed = null
      activeTab = 'reply'
      showAllParams = false
    }
    prevId = tid
    prevReconnect = rec

    const controller = new AbortController()
    const run = () => {
      api.getTicket(pid, tid, controller.signal).then(d => {
        if (!controller.signal.aborted) {
          detail = d
          failed = null
        }
      }).catch(e => {
        if (!controller.signal.aborted && e.name !== 'AbortError') failed = e.message
      })
    }

    if (immediate || !sig) {
      run()
      return () => controller.abort()
    }
    const timer = setTimeout(run, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  })

  function onkey(e) {
    if (e.key === 'Escape') onclose()
  }

  async function copyItem(key, value) {
    const ok = await copyText(value, `${t('copied')}: ${value}`)
    if (ok) {
      copiedKey = key
      setTimeout(() => { if (copiedKey === key) copiedKey = '' }, 1400)
    }
  }

  function outcomeTone(outcome) {
    if (outcome === 'pass') return 'done'
    if (outcome === 'rework') return 'warn'
    if (outcome === 'fail') return 'err'
    return 'stopped'
  }

  function msgKindLabel(kind) {
    if (kind === 'prompt') return t('msgPrompt')
    if (kind === 'steer') return t('msgSteer')
    if (kind === 'next') return t('msgNext')
    if (kind === 'reply') return t('msgReply')
    if (kind === 'assistant') return t('msgAssistant')
    if (kind === 'rejected') return t('msgRejected')
    return kind
  }

  const statusColor = {
    queued: 'var(--faint)',
    working: 'var(--status-working)',
    review: 'var(--status-review)',
    done: 'var(--status-done)'
  }

  let reversedTimeline = $derived.by(() => {
    const list = currentDetail?.timeline
    if (!list?.length) return []
    const out = []
    for (let idx = list.length - 1; idx >= 0; idx--) {
      out.push({ key: idx, item: list[idx] })
    }
    return out
  })
</script>

<svelte:window onkeydown={onkey} />

<div class="scrim" transition:fade={{ duration: 120 }} onclick={onclose} role="presentation"></div>

<aside class="drawer" transition:fly={{ x: 580, duration: 150, easing: cubicOut, opacity: 1 }} aria-label={ticket?.title}>
  <div class="head">
    <div class="status">
      {#if ticket}
        <span class="dot" class:pulse={liveWorking} style="background: {statusColor[ticket.status]}"></span>
        <span>{t(ticket.status)}</span>
        {#if ticket.flag === 'error'}<span class="chip err">{t('error')}</span>{/if}
        {#if ticket.flag === 'stopped'}<span class="chip stopped">{t('stopped')}</span>{/if}
        {#if ticket.outcome}<span class="chip {outcomeTone(ticket.outcome)}">{t(ticket.outcome)}</span>{/if}
        {#if ticket.contextWarning}<span class="chip warn">{t('contextHigh')}</span>{/if}
      {/if}
    </div>
    <div class="head-actions">
      {#if ticket}
        <div class="copy-group">
          <button
            class="copy-chip mono"
            title={ticket.id}
            onclick={() => copyItem('id', ticket.id)}
          >
            <Icon name={copiedKey === 'id' ? 'check' : 'copy'} size={11} />
            <span>ID</span>
          </button>
          {#if ticket.branch}
            <button
              class="copy-chip mono"
              title={ticket.branch}
              onclick={() => copyItem('branch', ticket.branch)}
            >
              <Icon name={copiedKey === 'branch' ? 'check' : 'branch'} size={11} />
              <span>{t('branch')}</span>
            </button>
          {/if}
          <button
            class="copy-chip mono"
            title={`broco diff ${ticket.id}`}
            onclick={() => copyItem('diff', `broco diff ${ticket.id}`)}
          >
            <Icon name={copiedKey === 'diff' ? 'check' : 'terminal'} size={11} />
            <span>diff</span>
          </button>
        </div>
      {/if}
      <button class="icon-btn" onclick={onclose} aria-label={t('close')}><Icon name="close" size={16} /></button>
    </div>
  </div>

  {#if failed && !ticket}
    <div class="body"><p class="muted">{t('somethingWrong')}: {failed}</p></div>
  {:else if !ticket}
    <div class="body">
      <div class="sk w70"></div><div class="sk w40"></div><div class="sk block"></div>
    </div>
  {:else}
    <div class="body">
      <h2>{ticket.title}</h2>

      <div class="ribbon">
        <div class="ribbon-items mono">
          <span class="rib-id" title={ticket.id}>{ticket.id}</span>
          {#if modelLabel}
            <span class="rib-sep">·</span>
            <span title={ticket.provider + ' · ' + ticket.model}>{modelLabel}{#if ticket.effort} ({ticket.effort}){/if}</span>
          {/if}
          <span class="rib-sep">·</span>
          <span>T{ticket.task || 1} ×{ticket.turn}</span>
          <span class="rib-sep">·</span>
          <span class="num">{duration(liveElapsed(ticket, app.now))}</span>
          <span class="rib-sep">·</span>
          <span class="num" title={localTime(ticket.updatedAt, { seconds: true, suffix: true })}>{ago(ticket.updatedAt, app.now)}</span>
        </div>
        <button class="rib-toggle" onclick={() => (showAllParams = !showAllParams)} aria-expanded={showAllParams}>
          <span>{t('allParams')}</span>
          <span class="chev" class:open={showAllParams}><Icon name="chevronDown" size={12} /></span>
        </button>
      </div>

      {#if showAllParams}
        <dl class="facts">
          <div><dt>{t('ticketName')}</dt><dd class="mono" title={ticket.id}>{ticket.id}</dd></div>
          <div><dt>{t('worker')}</dt><dd class="mono">{ticket.provider}</dd></div>
          <div><dt>{t('model')}</dt><dd class="mono" title={ticket.model}>{ticket.model}</dd></div>
          <div><dt>{t('effort')}</dt><dd>{ticket.effort || t('unknown')}</dd></div>
          <div><dt>{t('capability')}</dt><dd>{ticket.capability ? t(ticket.capability) : t('unknown')}</dd></div>
          <div><dt>{t('task')} / {t('turn')}</dt><dd class="mono">#{ticket.task || 1} · ×{ticket.turn}</dd></div>
          <div><dt>{t('cache')}</dt><dd class="num">{ticket.cacheRatio == null ? t('unknown') : (ticket.cacheRatio * 100).toFixed(1) + '%'}</dd></div>
          {#if spentText}
            <div><dt>{t('quotaSpent')}</dt><dd class="mono">{spentText}</dd></div>
          {/if}
          {#if ticket.outcome}
            <div class="span-2">
              <dt>{t('outcome')}</dt>
              <dd class="wrap-dd">
                <span class="chip {outcomeTone(ticket.outcome)}">{t(ticket.outcome)}</span>
                {#if ticket.outcomeReason}<span>{ticket.outcomeReason}</span>{/if}
                {#if ticket.outcomeAt}<span class="faint-ts mono">{localTime(ticket.outcomeAt, { seconds: true })}</span>{/if}
              </dd>
            </div>
          {/if}
          {#if ticket.branch}<div><dt>{t('branch')}</dt><dd class="mono" title={ticket.branch}>{ticket.branch}</dd></div>{/if}
          {#if ticket.worktree || ticket.cwd}
            <div>
              <dt>{ticket.worktree ? t('worktree') : t('cwd')}</dt>
              <dd class="mono" title={ticket.worktree || ticket.cwd}>{shortPath(ticket.worktree || ticket.cwd)}</dd>
            </div>
          {/if}
          <div><dt>{t('elapsed')}</dt><dd class="num">{duration(liveElapsed(ticket, app.now))}</dd></div>
          <div><dt>{t('created')}</dt><dd class="mono">{pickLocalTime(ticket.createdLocal, ticket.createdAsia, ticket.createdAt, { seconds: true })}</dd></div>
          <div class="span-2">
            <dt>{t('updated')}</dt>
            <dd>
              <span>{ago(ticket.updatedAt, app.now)}</span>
              <span class="faint-ts mono">({localTime(ticket.updatedAt, { seconds: true })})</span>
            </dd>
          </div>
        </dl>
      {/if}

      {#if ticket.flag || ticket.problem}
        <div class="callout err-box">
          <div class="callout-head">
            <strong>{t('problem')}{ticket.problem?.class ? ` · ${ticket.problem.class}` : ''}</strong>
            {#if ticket.problem?.retryable}<span class="chip warn">{t('retryable')}</span>{/if}
          </div>
          <p class="callout-msg mono">{ticket.problem?.message || translateActivity(ticket.activity)}</p>
          {#if ticket.problem?.resetsAt}
            <p class="callout-sub">{t('resetsAt')}: <span class="mono">{localTime(ticket.problem.resetsAt, { seconds: true })}</span></p>
          {/if}
        </div>
      {/if}

      {#if ticket.contextWarning}
        <div class="callout warn-box">
          <div class="callout-head">
            <strong>{t('contextWarningTitle')}</strong>
          </div>
          <p class="callout-sub">
            {tf('tokensUsed', {
              used: (ticket.contextWarning.inputTokens || 0).toLocaleString(),
              max: (ticket.contextWarning.contextTokens || 250000).toLocaleString(),
              threshold: (ticket.contextWarning.threshold || 150000).toLocaleString()
            })}
          </p>
          {#if ticket.contextWarning.actionable}
            <button class="cmd-hint mono" onclick={() => copyItem('handoff', tf('handoffHint', { name: ticket.id }))}>
              {tf('handoffHint', { name: ticket.id })}
            </button>
          {/if}
        </div>
      {/if}

      {#if ticket.status === 'queued' && ticket.queue}
        <div class="callout neutral-box">
          <div class="callout-head">
            <strong>{t('queue')}</strong>
            <span class="chip">{tf('queueBadge', { pos: ticket.queue.position, total: ticket.queue.totalQueued, limit: ticket.queue.limit })}</span>
          </div>
          {#if ticket.queue.activeNames?.length}
            <div class="active-slots">
              <span>{t('waitingOn')}:</span>
              {#each ticket.queue.activeNames as activeName}
                <button class="slot-link mono" onclick={() => onselect(activeName)}>{activeName}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if liveWorking}
        {@const step = progress?.currentStep || ticket.currentStep || translateActivity(ticket.activity)}
        {@const hb = progress?.lastHeartbeatAt || ticket.lastHeartbeatAt}
        <div class="now">
          <div class="now-main">
            <span class="dot pulse"></span>
            <span class="mono">{step}</span>
          </div>
          {#if hb || progress?.eventCount}
            <div class="now-meta">
              {#if hb}
                <span title={localTime(hb, { seconds: true, suffix: true })}>{t('heartbeat')}: {ago(hb, app.now)}</span>
              {/if}
              {#if progress?.eventCount}
                <span>{tf('eventsCount', { n: progress.eventCount })}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if ticket.parent || ticket.reviews?.length}
        <div class="rel-strip">
          {#if ticket.parent}
            <button class="rel-pill" onclick={() => onselect(ticket.parent)}>
              <Icon name="link" size={12} />
              <span>{t('parent')}:</span>
              <strong class="mono">{ticket.parent} #{ticket.parentTurn}</strong>
            </button>
          {/if}
          {#each ticket.reviews || [] as r}
            <button class="rel-pill" onclick={() => onselect(r.id)}>
              <Icon name="link" size={12} />
              <span>{t('children')}:</span>
              <strong class="mono">{r.id} · #{r.turn}</strong>
            </button>
          {/each}
        </div>
      {/if}

      {#if batch}
        <div class="batch-box">
          <div class="batch-head">
            <span class="mono batch-tag">{t('batchShard')} · {batch.prefix} [{batch.index}/{batch.count}]</span>
            {#if batch.input}
              <code class="batch-input mono" title={batch.input}>{batch.input}</code>
            {/if}
          </div>
          {#if batch.brief}
            <details class="brief-details">
              <summary>{t('batchBrief')}</summary>
              <pre class="brief-pre mono">{batch.brief}</pre>
            </details>
          {/if}
          {#if batch.shards?.length > 1}
            <div class="shard-pills">
              {#each batch.shards as s (s.name)}
                <button
                  class="shard-btn mono s-{s.status}"
                  class:current={s.name === ticket.id}
                  onclick={() => onselect(s.name)}
                  title={`${s.name}: ${s.input || ''}`}
                >
                  {s.index}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="tabs" role="tablist">
        <button
          class="seg-tab"
          role="tab"
          aria-selected={activeTab === 'reply'}
          class:active={activeTab === 'reply'}
          onclick={() => (activeTab = 'reply')}
        >
          <span>{t('tabReply')}</span>
          {#if currentDetail?.recentMessages?.length}
            <span class="tab-n mono">{currentDetail.recentMessages.length}</span>
          {/if}
        </button>
        <button
          class="seg-tab"
          role="tab"
          aria-selected={activeTab === 'files'}
          class:active={activeTab === 'files'}
          onclick={() => (activeTab = 'files')}
        >
          <span>{t('tabFiles')}</span>
          <span class="tab-n mono">{filesCount}</span>
        </button>
        <button
          class="seg-tab"
          role="tab"
          aria-selected={activeTab === 'timeline'}
          class:active={activeTab === 'timeline'}
          onclick={() => (activeTab = 'timeline')}
        >
          <span>{t('tabTimeline')}</span>
          <span class="tab-n mono">{reversedTimeline.length}</span>
        </button>
      </div>

      {#if activeTab === 'reply'}
        <section class="tab-panel">
          <h3>{t('lastReply')}</h3>
          {#if replyHtml}
            <div class="reply md-body">{@html replyHtml}</div>
          {:else if !currentDetail && !failed}
            <div class="sk block"></div>
          {:else}
            <p class="muted">{t('noReply')}</p>
          {/if}
        </section>

        {#if currentDetail?.recentMessages?.length}
          <section class="tab-panel">
            <details open={!currentDetail?.lastReply}>
              <summary class="sec-summary">{t('recentMessages')} ({currentDetail.recentMessages.length})</summary>
              <div class="msg-list">
                {#each currentDetail.recentMessages as m, idx (idx)}
                  <div class="msg-item kind-{m.kind}">
                    <div class="msg-head">
                      <span class="chip">{msgKindLabel(m.kind)}</span>
                      <span class="mono">#{m.turn}{m.number ? ` · m${m.number}` : ''}</span>
                    </div>
                    <div class="msg-body">{m.content}</div>
                    {#if m.error}<div class="msg-err mono">{m.error}</div>{/if}
                  </div>
                {/each}
              </div>
            </details>
          </section>
        {/if}

        {#if currentDetail?.tasks?.length}
          <section class="tab-panel">
            <h3>{t('tasks')} ({currentDetail.tasks.length})</h3>
            <div class="task-list">
              {#each currentDetail.tasks as tk (tk.task)}
                <div class="task-item">
                  <div class="task-top">
                    <strong class="mono">#{tk.task}</strong>
                    <span class="task-title">{tk.title}</span>
                    {#if tk.outcome}
                      <span class="chip {outcomeTone(tk.outcome)}">{t(tk.outcome)}</span>
                    {:else}
                      <span class="chip">{t('unrecorded')}</span>
                    {/if}
                  </div>
                  <div class="task-meta">
                    <span>{tf('turnsRange', { start: tk.startTurn, end: tk.endTurn })}</span>
                    <span class="mono">{tk.model}{tk.effort ? ` · ${tk.effort}` : ''}</span>
                    {#if tk.outcomeAt}
                      <span class="mono">{localTime(tk.outcomeAt)}</span>
                    {/if}
                  </div>
                  {#if tk.outcomeReason}
                    <p class="task-reason">{tk.outcomeReason}</p>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if ticket.note}
          <section class="tab-panel"><h3>{t('note')}</h3><p class="plain-p">{ticket.note}</p></section>
        {/if}
        {#if ticket.rules?.length}
          <section class="tab-panel"><h3>{t('rules')}</h3><ul class="items">{#each ticket.rules as rule}<li>{rule}</li>{/each}</ul></section>
        {/if}
        {#if ticket.interjections?.length}
          <section class="tab-panel">
            <h3>{t('followups')}</h3>
            <ul class="items">
              {#each ticket.interjections as i}
                <li>#{i.number} · {t('turn')} {i.turn} · {t(i.outcome === 'queued' ? 'next' : i.outcome)} · {i.reason}</li>
              {/each}
            </ul>
          </section>
        {/if}
      {:else if activeTab === 'files'}
        <section class="tab-panel">
          {#if ticket.branch || ticket.worktree || ticket.cwd}
            <div class="file-env mono">
              {#if ticket.branch}
                <span title={ticket.branch}>⎇ {compactBranch(ticket.branch)}</span>
              {/if}
              {#if ticket.worktree || ticket.cwd}
                <span title={ticket.worktree || ticket.cwd}>{shortPath(ticket.worktree || ticket.cwd)}</span>
              {/if}
            </div>
          {/if}

          {#if ticket.changedFiles?.length}
            <ul class="file-list mono">
              {#each ticket.changedFiles as f}
                <li>
                  <span class="f-stat s-{(f.status || 'M').toLowerCase()}">{f.status || 'M'}</span>
                  <span class="f-path">{f.path}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted">{ticket.changedFiles == null ? t('unknown') : t('unchanged')}</p>
          {/if}

          {#if ticket.cleanupHint}
            <div class="cleanup-box">
              <strong>{t('cleanupTitle')}:</strong>
              <span class="mono">{ticket.cleanupHint}</span>
            </div>
          {/if}
        </section>
      {:else}
        <section class="tab-panel">
          {#if reversedTimeline.length}
            <ol class="timeline">
              {#each reversedTimeline as { key, item: e } (key)}
                {@const displayTs = e.lastTs ?? e.ts}
                <li class="cat-{timelineCategory(e.kind)}">
                  <span class="tl-dot"></span>
                  <span class="tl-text">
                    #{e.turn} · {translateActivity(e.rawSummary ?? e.summary)}
                    {#if e.count > 1}
                      <span class="tl-count mono">×{e.count}</span>
                    {/if}
                  </span>
                  <span class="tl-time mono" title={localTime(displayTs, { seconds: true, suffix: true })}>{clock(displayTs)}</span>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="muted">{t('unknown')}</p>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--scrim);
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    width: min(580px, 100vw);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--line-strong);
    box-shadow: var(--drawer-shadow);
  }

  .head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 48px;
    padding: 6px 12px 6px 18px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    gap: 8px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 650;
    flex-wrap: wrap;
    min-width: 0;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .copy-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .copy-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 25px;
    padding: 0 7px;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    box-shadow: var(--keycap);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    transition: border-color 0.12s, color 0.12s, transform 0.08s;
  }
  .copy-chip:hover {
    color: var(--ink);
    border-color: var(--line-strong);
    background: var(--surface-raise);
  }
  .copy-chip:active {
    transform: translateY(1px);
    box-shadow: none;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 18px 32px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.38;
    letter-spacing: -0.02em;
    word-break: break-word;
  }

  .ribbon {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .ribbon-items {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted);
    min-width: 0;
  }

  .rib-id {
    color: var(--ink);
    font-weight: 650;
  }

  .rib-sep { color: var(--faint); }

  .rib-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 650;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: var(--radius-chip);
    border: 1px solid var(--line);
    background: var(--surface);
  }
  .rib-toggle:hover { color: var(--ink); border-color: var(--line-strong); }
  .chev { display: inline-flex; transition: transform 0.12s; }
  .chev.open { transform: rotate(180deg); }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 9px 14px;
    margin: 0;
    padding: 12px 13px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
  }
  .facts div { min-width: 0; }
  .facts .span-2 { grid-column: 1 / -1; }
  dt { font-size: 11px; color: var(--muted); margin-bottom: 1px; }
  dd { margin: 0; font-size: 12.5px; font-weight: 580; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dd.wrap-dd {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    white-space: normal;
  }
  .faint-ts {
    font-size: 11px;
    font-weight: 450;
    color: var(--faint);
  }

  .callout {
    padding: 10px 12px;
    border-radius: var(--radius-card);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
  }
  .err-box {
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--status-danger) 42%, var(--line));
    color: var(--status-danger);
  }
  .warn-box {
    background: var(--review-soft);
    border-color: color-mix(in srgb, var(--status-review) 40%, var(--line));
    color: var(--ink);
  }
  .neutral-box {
    background: var(--surface-recessed);
    color: var(--ink);
  }
  .callout-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .callout-msg {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .callout-sub {
    margin: 0;
    color: var(--muted);
  }
  .cmd-hint {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--ink);
    font-size: 11.5px;
    overflow-x: auto;
  }
  .cmd-hint:hover { border-color: var(--brand-green); }

  .active-slots {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    color: var(--muted);
  }
  .slot-link {
    padding: 1px 6px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--brand-green);
    font-size: 11px;
  }

  .now {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 11px;
    border-radius: var(--radius-card);
    background: var(--working-soft);
    border: 1px solid color-mix(in srgb, var(--status-working) 38%, var(--line));
    color: var(--ink);
    font-size: 12px;
  }
  .now-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .now-main .mono { overflow-wrap: anywhere; }
  .now .dot { width: 7px; height: 7px; background: var(--status-working); }
  .now-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
  }

  .rel-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rel-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
  }
  .rel-pill strong { color: var(--status-review); font-weight: 650; }
  .rel-pill:hover { border-color: var(--status-review); background: var(--surface-raise); }

  .batch-box {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 9px 11px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
  }
  .batch-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .batch-tag {
    font-size: 11px;
    font-weight: 700;
    color: var(--brand-green);
  }
  .batch-input {
    font-size: 11px;
    color: var(--muted);
    word-break: break-all;
  }
  .brief-details summary, .sec-summary {
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .brief-pre {
    margin: 7px 0 0;
    padding: 8px 10px;
    border-radius: var(--radius-chip);
    background: var(--bg);
    border: 1px solid var(--line);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 160px;
    overflow-y: auto;
  }
  .shard-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .shard-btn {
    min-width: 25px;
    height: 22px;
    padding: 0 5px;
    border-radius: var(--radius-chip);
    font-size: 11px;
    font-weight: 650;
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .shard-btn.s-done { background: var(--done-soft); color: var(--status-done); }
  .shard-btn.s-review { background: var(--review-soft); color: var(--status-review); }
  .shard-btn.s-working { background: var(--working-soft); color: var(--status-working); }
  .shard-btn.s-error { background: var(--danger-soft); color: var(--status-danger); }
  .shard-btn.current { outline: 2px solid var(--brand-green); outline-offset: 1px; }

  .tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 3px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
  }

  .seg-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--radius-chip);
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    border: 1px solid transparent;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .seg-tab:hover { color: var(--ink); }
  .seg-tab.active {
    background: var(--surface-raise);
    color: var(--ink);
    border-color: var(--line-strong);
    box-shadow: var(--keycap);
  }

  .tab-n {
    font-size: 10.5px;
    padding: 0 5px;
    height: 16px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    color: var(--muted);
  }

  .tab-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .reply {
    padding: 13px 14px;
    border-radius: var(--radius-card);
    border: 1px solid var(--line);
    background: var(--surface-recessed);
    font-size: 13px;
    line-height: 1.62;
    word-break: break-word;
  }

  .md-body :global(.md-p) { margin: 0 0 9px; }
  .md-body :global(.md-p:last-child) { margin-bottom: 0; }
  .md-body :global(.md-h) {
    font-weight: 700;
    color: var(--ink);
    margin: 12px 0 6px;
    letter-spacing: -0.01em;
  }
  .md-body :global(.md-h:first-child) { margin-top: 0; }
  .md-body :global(.md-h1) { font-size: 15px; }
  .md-body :global(.md-h2) { font-size: 14px; }
  .md-body :global(.md-h3), .md-body :global(.md-h4) { font-size: 13px; }
  .md-body :global(.md-list) {
    margin: 0 0 9px;
    padding-inline-start: 18px;
  }
  .md-body :global(.md-list:last-child) { margin-bottom: 0; }
  .md-body :global(.md-list li) { margin: 3px 0; }
  .md-body :global(.md-code) {
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 1px 5px;
    border-radius: var(--radius-chip);
    background: var(--surface-raise);
    border: 1px solid var(--line);
    color: var(--ink);
  }
  .md-body :global(.md-pre-wrap) {
    position: relative;
    margin: 8px 0;
  }
  .md-body :global(.md-lang) {
    position: absolute;
    top: 5px;
    right: 8px;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--faint);
    text-transform: uppercase;
  }
  .md-body :global(.md-pre) {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-card);
    background: var(--term-bg);
    border: 1px solid var(--line);
    color: #F2EFE8;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    overflow-x: auto;
  }

  .msg-list {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .msg-item {
    padding: 9px 11px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 12.5px;
  }
  .msg-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 5px;
    color: var(--muted);
    font-size: 11px;
  }
  .msg-body {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow-y: auto;
  }
  .msg-err {
    margin-top: 4px;
    color: var(--status-danger);
    font-size: 11px;
  }

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .task-item {
    padding: 9px 11px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .task-top {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
  }
  .task-title {
    flex: 1;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    font-size: 11px;
    color: var(--muted);
  }
  .task-reason {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--ink);
  }

  .file-env {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .file-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 12px;
  }
  .f-stat {
    width: 18px;
    height: 18px;
    flex: none;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-chip);
    font-size: 10.5px;
    font-weight: 700;
    background: var(--surface-raise);
    color: var(--muted);
  }
  .f-stat.s-a { background: var(--brand-soft); color: var(--brand-green); }
  .f-stat.s-d { background: var(--danger-soft); color: var(--status-danger); }
  .f-stat.s-m { background: var(--working-soft); color: var(--status-working); }
  .f-path { min-width: 0; overflow-wrap: anywhere; color: var(--ink); }

  .cleanup-box {
    padding: 8px 10px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 3px;
    overflow-wrap: anywhere;
  }

  .plain-p { margin: 0; font-size: 13px; }
  .items { margin: 0; padding-inline-start: 18px; font-size: 12.5px; overflow-wrap: anywhere; }
  .muted { color: var(--muted); margin: 0; font-size: 12.5px; }

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    position: relative;
  }
  .timeline::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: var(--line-strong);
  }
  .timeline li {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 0;
    font-size: 12.5px;
  }
  .tl-dot {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--surface);
    border: 2px solid var(--line-strong);
    transform: translateY(1px);
  }
  .timeline li.cat-done .tl-dot { border-color: var(--status-done); }
  .timeline li.cat-prompt .tl-dot, .timeline li.cat-tool .tl-dot { border-color: var(--status-working); }
  .timeline li.cat-error .tl-dot { border-color: var(--status-danger); }
  .timeline li.cat-stopped .tl-dot { border-color: var(--status-review); }
  .tl-text { flex: 1; min-width: 0; word-break: break-word; }
  .tl-count {
    display: inline-block;
    margin-left: 5px;
    padding: 0 5px;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 10.5px;
  }
  .tl-time {
    flex: none;
    font-size: 11px;
    color: var(--faint);
  }

  .sk {
    height: 16px;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
  }
  .sk.w70 { width: 70%; }
  .sk.w40 { width: 40%; }
  .sk.block { height: 110px; }
</style>
