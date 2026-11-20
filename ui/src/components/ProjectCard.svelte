<script>
  import { app } from '../lib/store.svelte.js'
  import { t, tf } from '../lib/i18n.svelte.js'
  import { ago, localTime, shortPath } from '../lib/format.js'

  let { project, onopen } = $props()

  const cols = ['queued', 'working', 'review', 'done']
  let total = $derived(cols.reduce((n, c) => n + (project.counts?.[c] || 0), 0))
  let running = $derived(project.runningCount ?? (project.counts?.working || 0))
  let active = $derived(running > 0)
  let needsReview = $derived((project.attention || 0) > 0 || (project.counts?.review || 0) > 0)
  let limit = $derived(project.concurrency ?? 3)
  let allowSummary = $derived(
    project.worker
      ? project.worker + (project.allow?.length > 1 ? ` +${project.allow.length - 1}` : '')
      : (project.allow || []).join(', ')
  )
</script>

<div
  class="card"
  class:is-working={active}
  class:is-review={!active && needsReview}
  role="link"
  tabindex="0"
  onclick={onopen}
  onkeydown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onopen())}
>
  <div class="top-bar" aria-hidden="true">
    {#if total === 0}
      <span class="seg empty"></span>
    {:else}
      {#each cols as c}
        {#if project.counts?.[c]}
          <span class="seg {c}" style="flex: {project.counts[c]}"></span>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="inner">
    <div class="row">
      <div class="title">
        <span class="name">{project.name}</span>
        {#if project.implicit}<span class="l0-tag mono">L0</span>{/if}
        {#if active}<span class="dot live pulse" title={t('working')}></span>{/if}
      </div>
      {#if project.attention > 0}
        <span class="attn mono">{project.attention} {project.attention === 1 ? t('needsYouOne') : t('needsYou')}</span>
      {/if}
    </div>
    <div class="path mono" title={project.repoPath}>{shortPath(project.repoPath)}</div>

    <div class="counts">
      {#each cols as c}
        <div class="count" class:nonzero={(project.counts?.[c] || 0) > 0}>
          <span class="n num">{project.counts?.[c] || 0}</span>
          <span class="l"><span class="dot {c}"></span><span class="l-text">{t(c)}</span></span>
        </div>
      {/each}
    </div>

    <div class="foot">
      <span class="when num" title={localTime(project.updatedAt, { seconds: true, suffix: true })}>
        {t('updated')} {ago(project.updatedAt, app.now)}
      </span>
      <div class="foot-right">
        <span class="chip" class:working={active}>
          {active ? tf('slotsLoad', { running, limit }) : tf('concurrencyShort', { limit })}
        </span>
        {#if allowSummary}
          <span class="allow mono" title={(project.allow || []).join(', ')}>{allowSummary}</span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    min-height: 176px;
    border-radius: var(--radius-panel);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--card-highlight);
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.13s, background 0.13s;
  }
  .card:hover {
    border-color: var(--line-strong);
    background: var(--surface-raise);
  }
  .card.is-working {
    border-color: color-mix(in srgb, var(--status-working) 48%, var(--line));
  }
  .card.is-review {
    border-color: color-mix(in srgb, var(--status-review) 46%, var(--line));
  }

  .top-bar {
    display: flex;
    gap: 1px;
    height: 3px;
    background: var(--surface-recessed);
    flex: none;
  }
  .seg { min-width: 4px; }
  .seg.empty { flex: 1; background: var(--line); opacity: 0.45; }
  .seg.queued { background: var(--faint); }
  .seg.working { background: var(--status-working); }
  .seg.review { background: var(--status-review); }
  .seg.done { background: var(--status-done); }

  .inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 12px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .name {
    font-size: 15.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .live { background: var(--status-working); }

  .l0-tag {
    flex: none;
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    height: 17px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-chip);
    border: 1px solid var(--line-strong);
    background: var(--surface-recessed);
    color: var(--muted);
  }

  .attn {
    flex: none;
    font-size: 11px;
    font-weight: 650;
    padding: 1px 7px;
    border-radius: var(--radius-chip);
    background: var(--review-soft);
    border: 1px solid color-mix(in srgb, var(--status-review) 36%, transparent);
    color: var(--status-review);
  }

  .path {
    color: var(--faint);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: -5px;
  }

  .counts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    padding: 8px 0 4px;
  }

  .count {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .n {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.15;
    color: var(--faint);
    letter-spacing: -0.02em;
  }
  .count.nonzero .n { color: var(--ink); }

  .l {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
    min-width: 0;
  }
  .l-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l .dot { width: 5px; height: 5px; }
  .dot.queued { background: var(--faint); }
  .dot.working { background: var(--status-working); }
  .dot.review { background: var(--status-review); }
  .dot.done { background: var(--status-done); }

  .foot {
    margin-top: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 9px;
    border-top: 1px solid var(--line);
    min-width: 0;
  }

  .when {
    font-size: 11.5px;
    color: var(--faint);
    white-space: nowrap;
    flex: none;
  }

  .foot-right {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .allow {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 116px;
  }
</style>
