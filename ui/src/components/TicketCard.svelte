<script>
  import { app } from '../lib/store.svelte.js'
  import { t, tf, translateActivity } from '../lib/i18n.svelte.js'
  import { compactBranch, compactInput, compactModel, duration, ago, shortAgo, formatSpent, isLiveWorking, liveElapsed, localTime, pickLocalTime } from '../lib/format.js'

  let { ticket, batch = null, selected = false, linked = false, onhover = null, onclick } = $props()

  let files = $derived(ticket.changedFiles ?? [])
  let liveWorking = $derived(isLiveWorking(ticket))
  let isError = $derived(ticket.flag === 'error')
  let isStopped = $derived(ticket.flag === 'stopped')
  let isCompactDone = $derived(ticket.status === 'done' && !ticket.flag)
  let elapsed = $derived(liveElapsed(ticket, app.now))
  let resolvedBatch = $derived(ticket.batch ?? batch)
  let spentText = $derived(formatSpent(ticket.quota))
  let stepLabel = $derived(ticket.currentStep || translateActivity(ticket.activity))
  let modelLabel = $derived(compactModel(ticket.provider, ticket.model))
  let fullModelTitle = $derived(ticket.provider && ticket.model && ticket.provider !== ticket.model ? `${ticket.provider} · ${ticket.model}` : (ticket.model || ticket.provider || ''))
  let shortBranch = $derived(compactBranch(ticket.branch))

  function outcomeTone(outcome) {
    if (outcome === 'pass') return 'done'
    if (outcome === 'rework') return 'warn'
    if (outcome === 'fail') return 'err'
    return 'stopped'
  }
</script>

{#if isCompactDone}
  <button
    class="tc compact-done"
    class:selected
    class:linked
    onmouseenter={() => onhover?.(true)}
    onmouseleave={() => onhover?.(false)}
    onfocus={() => onhover?.(true)}
    onblur={() => onhover?.(false)}
    {onclick}
  >
    <div class="done-l1">
      <span class="done-title" title={ticket.title}>
        {#if resolvedBatch}
          <span class="shard-tag mono">[{resolvedBatch.index}/{resolvedBatch.count}]</span>
        {/if}
        {ticket.title}
      </span>
      {#if ticket.outcome === 'rework' || ticket.outcome === 'fail' || ticket.outcome === 'blocked'}
        <span class="chip {outcomeTone(ticket.outcome)}">{t(ticket.outcome)}</span>
      {:else}
        <span class="done-check" title={t(ticket.outcome || 'pass')}>✓</span>
      {/if}
    </div>
    <div class="done-l2 mono">
      <div class="done-meta">
        {#if shortBranch}
          <span class="dm-item" title={ticket.branch}>⎇ {shortBranch}</span>
        {/if}
        {#if files.length}
          <span class="dm-item" title={files.map(f => f.path).join(', ')}>+{files.length}f</span>
        {/if}
        {#if ticket.cacheRatio != null}
          <span class="dm-item" title={t('cache')}>{(ticket.cacheRatio * 100).toFixed(1)}%</span>
        {/if}
        {#if modelLabel}
          <span class="dm-item dm-model" title={fullModelTitle}>{modelLabel}</span>
        {/if}
      </div>
      <span class="time num" title={localTime(ticket.outcomeAt || ticket.updatedAt, { seconds: true, suffix: true })}>
        {shortAgo(ticket.outcomeAt || ticket.updatedAt, app.now)}
      </span>
    </div>
  </button>
{:else}
  <button
    class="tc {ticket.status}"
    class:live-working={liveWorking}
    class:selected
    class:linked
    class:flagged={!!ticket.flag}
    class:is-error={isError}
    class:is-stopped={isStopped}
    onmouseenter={() => onhover?.(true)}
    onmouseleave={() => onhover?.(false)}
    onfocus={() => onhover?.(true)}
    onblur={() => onhover?.(false)}
    {onclick}
  >
    <div class="top">
      <span class="title">
        {#if resolvedBatch}
          <span class="shard-tag mono">[{resolvedBatch.index}/{resolvedBatch.count}]</span>
        {/if}
        {ticket.title}
      </span>
      {#if isError}
        <span class="chip err">{t('error')}{ticket.problem?.class ? ' · ' + ticket.problem.class : ''}</span>
      {:else if isStopped}
        <span class="chip stopped">{t('stopped')}</span>
      {:else if ticket.outcome}
        <span class="chip {outcomeTone(ticket.outcome)}">{t(ticket.outcome)}</span>
      {/if}
    </div>

    {#if isError}
      <div class="err-strip mono" title={ticket.problem?.message || translateActivity(ticket.activity)}>
        <span class="err-code">{ticket.problem?.class || 'ERR'}</span>
        <span class="err-msg">{ticket.problem?.message || translateActivity(ticket.activity) || t('error')}</span>
      </div>
    {:else if isStopped && (ticket.problem?.message || ticket.activity)}
      <div class="flag-row">
        <span class="act-text">{ticket.problem?.message || translateActivity(ticket.activity)}</span>
      </div>
    {:else if liveWorking && stepLabel}
      <div
        class="activity"
        title={ticket.lastHeartbeatAt ? `${t('heartbeat')}: ${localTime(ticket.lastHeartbeatAt, { seconds: true, suffix: true })}` : ''}
      >
        <span class="step-bars" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="act-text">{stepLabel}</span>
      </div>
    {:else if ticket.status === 'queued' && ticket.queue}
      <div
        class="queue-row"
        title={ticket.queue.activeNames?.length ? `${t('waitingOn')}: ${ticket.queue.activeNames.join(', ')}` : ''}
      >
        <span class="chip">{tf('queueBadge', { pos: ticket.queue.position, total: ticket.queue.totalQueued, limit: ticket.queue.limit })}</span>
      </div>
    {/if}

    {#if resolvedBatch?.input || ticket.contextWarning || spentText}
      <div class="badges-row">
        {#if resolvedBatch?.input}
          <span class="chip mono" title={resolvedBatch.input}>{compactInput(resolvedBatch.input)}</span>
        {/if}
        {#if ticket.contextWarning}
          <span class="chip warn" title={ticket.contextWarning.message}>{t('contextHigh')}</span>
        {/if}
        {#if spentText}
          <span class="chip mono" title={t('quotaSpent')}>{spentText}</span>
        {/if}
      </div>
    {/if}

    {#if shortBranch || ticket.parent || ticket.reviews?.length || ticket.interjections?.length || files.length || ticket.cacheRatio != null}
      <div class="collab mono">
        {#if shortBranch}<span title={ticket.branch}>⎇ {shortBranch}</span>{/if}
        {#if files.length}<span title={files.map(f => f.path).join(', ')}>+{files.length}f · {files[0].path}</span>{/if}
        {#if ticket.cacheRatio != null}<span>{t('cache')}: {(ticket.cacheRatio * 100).toFixed(1)}%</span>{/if}
        {#if ticket.parent}<span class="rel-tag">{t('parent')}: {ticket.parent} #{ticket.parentTurn}</span>{/if}
        {#if ticket.reviews?.length}<span class="rel-tag">{t('children')}: {ticket.reviews.length}</span>{/if}
        {#if ticket.interjections?.length}
          {@const last = ticket.interjections.at(-1)}
          <span>{t('followups')} #{last.number}: {t(last.outcome === 'queued' ? 'next' : last.outcome)}</span>
        {/if}
      </div>
    {/if}

    <div class="foot">
      <div class="foot-left">
        {#if modelLabel}
          <span class="chip mono model" title={fullModelTitle}>{modelLabel}</span>
        {/if}
        {#if ticket.effort}<span class="turn mono">{ticket.effort}</span>{/if}
        {#if ticket.capability === 'degraded'}<span class="turn">{t('degraded')}</span>{/if}
        {#if ticket.task > 1}<span class="turn mono" title={t('task')}>T{ticket.task}</span>{/if}
        {#if ticket.turn > 1}<span class="turn mono" title={t('turn')}>×{ticket.turn}</span>{/if}
      </div>
      {#if liveWorking || ticket.status === 'review' || ticket.flag}
        <span class="time num" title={pickLocalTime(ticket.startedLocal, ticket.startedAsia, ticket.startedAt || ticket.updatedAt, { seconds: true, suffix: true })}>{duration(elapsed)}</span>
      {:else}
        <span class="time num" title={pickLocalTime(ticket.createdLocal, ticket.createdAsia, ticket.createdAt, { seconds: true, suffix: true })}>{ago(ticket.createdAt, app.now)}</span>
      {/if}
    </div>
  </button>
{/if}

<style>
  .tc {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px 11px 9px 13px;
    border-radius: var(--radius-card);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--card-highlight);
    text-align: left;
    transition: border-color 0.12s, background 0.12s;
  }
  .tc:hover {
    border-color: var(--line-strong);
    background: var(--surface-raise);
  }
  .tc.selected {
    border-color: var(--brand-green);
    box-shadow: 0 0 0 1px var(--brand-green);
  }
  .tc.linked {
    border-color: var(--helmet-yellow);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--helmet-yellow) 70%, transparent);
  }

  .tc.live-working::before,
  .tc.is-error::before,
  .tc.is-stopped::before,
  .tc.review:not(.flagged)::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    border-radius: var(--radius-card) 0 0 var(--radius-card);
  }

  .tc.live-working::before { background: var(--status-working); }
  .tc.review:not(.flagged)::before { background: var(--status-review); }
  .tc.is-error::before { background: var(--status-danger); }
  .tc.is-stopped::before { background: var(--muted); }

  .tc.is-error {
    background: color-mix(in srgb, var(--status-danger) 6%, var(--surface));
    border-color: color-mix(in srgb, var(--status-danger) 48%, var(--line));
  }
  .tc.is-error:hover {
    background: color-mix(in srgb, var(--status-danger) 9%, var(--surface));
    border-color: var(--status-danger);
  }

  .tc.is-stopped {
    border-color: var(--line-strong);
  }

  .tc.compact-done {
    gap: 4px;
    padding: 7px 10px;
    background: color-mix(in srgb, var(--surface) 84%, var(--surface-recessed));
  }
  .tc.compact-done:hover {
    background: var(--surface);
  }

  .done-l1 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .done-title {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 560;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tc.compact-done:hover .done-title { color: var(--ink); }

  .done-check {
    flex: none;
    font-size: 12px;
    font-weight: 700;
    color: var(--status-done);
    line-height: 1;
  }

  .done-l2 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--faint);
    min-width: 0;
  }

  .done-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
  }

  .dm-item {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dm-item + .dm-item::before {
    content: '·';
    margin-right: 5px;
    color: var(--line-strong);
  }
  .dm-model {
    color: var(--muted);
    flex-shrink: 0;
  }

  .top {
    display: flex;
    align-items: flex-start;
    gap: 7px;
  }

  .title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.38;
    color: var(--ink);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .shard-tag {
    font-size: 11px;
    font-weight: 700;
    color: var(--brand-green);
    margin-right: 3px;
  }

  .err-strip {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 5px 7px;
    border-radius: var(--radius-chip);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--status-danger) 36%, transparent);
    font-size: 11px;
    color: var(--status-danger);
    min-width: 0;
  }

  .err-code {
    flex: none;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .err-msg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity, .queue-row, .flag-row {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }

  .step-bars {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }

  .step-bars span {
    width: 4px;
    height: 7px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--status-working) 78%, var(--muted));
    opacity: 0.25;
    animation: stepPulse 1.2s steps(1, end) infinite;
  }
  .step-bars span:nth-child(2) { animation-delay: 0.25s; }
  .step-bars span:nth-child(3) { animation-delay: 0.5s; }

  @keyframes stepPulse {
    0%, 100% { opacity: 0.24; }
    35%, 65% { opacity: 0.92; }
  }

  .act-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .badges-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .collab {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 9px;
    color: var(--muted);
    font-size: 11px;
    min-width: 0;
  }
  .collab span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rel-tag { color: var(--status-review); }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
  }

  .foot-left {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    min-width: 0;
  }

  .model {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
  }

  .turn {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }

  .time {
    flex: none;
    font-size: 11px;
    color: var(--faint);
    white-space: nowrap;
  }
</style>
