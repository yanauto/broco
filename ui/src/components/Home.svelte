<script>
  import { flip } from 'svelte/animate'
  import { app, copyText, go, projectHash, settingsHash } from '../lib/store.svelte.js'
  import { t, loginStatusLabel } from '../lib/i18n.svelte.js'
  import { buildCrewTelemetry } from '../lib/roster-metrics.js'
  import { localTime } from '../lib/format.js'
  import Icon from './Icon.svelte'
  import SegMeter from './SegMeter.svelte'
  import ProjectCard from './ProjectCard.svelte'

  const descIso = (a, b) => {
    const x = a.updatedAt || ''
    const y = b.updatedAt || ''
    return y > x ? 1 : y < x ? -1 : 0
  }

  let sorted = $derived([...app.projects].sort(descIso))
  let crew = $derived(buildCrewTelemetry(app.roster, app.tickets))
  let copiedCmd = $state(false)

  async function copySetup() {
    const ok = await copyText('broco setup', `${t('copied')}: broco setup`)
    if (ok) {
      copiedCmd = true
      setTimeout(() => { copiedCmd = false }, 1400)
    }
  }
</script>

<section class="wrap">
  <div class="crew-dock">
    <div class="dock-head">
      <div class="dock-title">
        <span class="dock-eyebrow mono">{t('crewDock')}</span>
        {#if crew.length > 0}
          <span class="dock-count mono">{crew.length}</span>
        {/if}
      </div>
      <button class="dock-link" onclick={() => go(settingsHash('global'))}>
        <Icon name="sliders" size={12} />
        <span>{t('settings')}</span>
      </button>
    </div>

    {#if crew.length > 0}
      <div class="dock-grid">
        {#each crew as item (item.id)}
          <div class="dock-card" class:tight={item.tight} class:working={item.isWorking}>
            <div class="dock-top">
              <span class="dock-dot" class:working={item.isWorking} class:err={item.tight} class:ok={!item.tight && !item.isWorking && item.isReady}></span>
              <span class="mono dock-id" title={item.id}>{item.shortName}</span>
              {#if item.isDefault}<span class="chip accent">{t('defaultBadge')}</span>{/if}
              {#if item.isWorking}<span class="chip working">{t('working')}</span>{/if}
              <span class="dock-spacer"></span>
              <span class="mono dock-pct" class:err={item.tight} class:warn={!item.tight && item.tone === 'warn'}>
                {#if item.observed}
                  {t('quotaObsShort')}
                {:else if item.usedPercent !== null}
                  {item.usedPercent}%
                {:else}
                  {loginStatusLabel(item.worker.installed, item.worker.loginStatus)}
                {/if}
              </span>
            </div>
            <div class="dock-bot">
              <SegMeter used={item.usedPercent} size="md" />
              <span class="dock-sub mono">
                {#if item.windowLabel}
                  {item.windowLabel}{#if item.resetsAt} · {localTime(item.resetsAt, { year: false })}{/if}
                {:else if item.resetsAt}
                  {t('quotaResets')}{localTime(item.resetsAt, { year: false })}
                {:else}
                  {item.worker.defaultModel || item.worker.cli || item.id}
                {/if}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="dock-empty">
        <span>{t('crewEmpty')}</span>
        <button class="dock-link" onclick={() => go(settingsHash('global'))}>{t('openSettings')}</button>
      </div>
    {/if}
  </div>

  <div class="head">
    <div>
      <h1>{t('projects')}</h1>
      <p class="tag">{t('tagline')}</p>
    </div>
    {#if sorted.length > 0}
      <span class="proj-count mono">{sorted.length}</span>
    {/if}
  </div>

  {#if app.projectsLoaded && sorted.length === 0}
    <div class="empty">
      <img class="empty-mascot" src="./broco-foreman-256.png" alt="" width="64" height="64" />
      <h2>{t('noProjects')}</h2>
      <p>{t('noProjectsHint')}</p>
      <div class="cmd-strip">
        <code class="mono"><span class="prompt">$</span> broco setup</code>
        <button class="btn btn-keycap copy-btn" onclick={copySetup}>
          <Icon name={copiedCmd ? 'check' : 'copy'} size={13} />
          <span>{copiedCmd ? t('copied') : t('copyCmd')}</span>
        </button>
      </div>
    </div>
  {:else}
    <div class="grid">
      {#each sorted as p (p.id)}
        <div animate:flip={{ duration: 220 }}>
          <ProjectCard project={p} onopen={() => go(projectHash(p.id))} />
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .wrap {
    width: 100%;
    max-width: 1220px;
    margin: 0 auto;
    padding: 20px 22px 56px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .crew-dock {
    padding: 12px 14px;
    border-radius: var(--radius-panel);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--card-highlight);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .dock-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .dock-title {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .dock-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .dock-count {
    font-size: 11px;
    font-weight: 700;
    padding: 0 6px;
    height: 18px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    color: var(--muted);
  }

  .dock-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 2px 7px;
    border-radius: var(--radius-chip);
    border: 1px solid transparent;
  }
  .dock-link:hover {
    color: var(--ink);
    background: var(--surface-raise);
    border-color: var(--line);
  }

  .dock-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }

  .dock-card {
    padding: 8px 10px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .dock-card.working {
    border-color: color-mix(in srgb, var(--status-working) 48%, var(--line));
  }
  .dock-card.tight {
    background: var(--danger-tint);
    border-color: color-mix(in srgb, var(--status-danger) 48%, var(--line));
  }

  .dock-top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .dock-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--faint);
    flex: none;
  }
  .dock-dot.ok { background: var(--brand-green); }
  .dock-dot.working { background: var(--status-working); }
  .dock-dot.err { background: var(--status-danger); }

  .dock-id {
    font-size: 12px;
    font-weight: 650;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dock-spacer { flex: 1; }

  .dock-pct {
    font-size: 11.5px;
    font-weight: 650;
    color: var(--muted);
    white-space: nowrap;
  }
  .dock-pct.err { color: var(--status-danger); }
  .dock-pct.warn { color: var(--status-review); }

  .dock-bot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .dock-sub {
    font-size: 10.5px;
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dock-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12.5px;
    color: var(--muted);
    padding: 4px 2px;
  }

  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.025em;
  }

  .tag {
    margin: 3px 0 0;
    font-size: 13px;
    color: var(--muted);
  }

  .proj-count {
    font-size: 12px;
    font-weight: 650;
    padding: 2px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
    gap: 14px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 56px 24px;
    border-radius: var(--radius-panel);
    border: 1px solid var(--line);
    background: var(--surface);
    box-shadow: var(--card-highlight);
  }

  .empty-mascot {
    width: 64px;
    height: 64px;
    display: block;
    image-rendering: pixelated;
    filter: var(--mascot-outline);
  }

  .empty h2 {
    margin: 14px 0 6px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .empty p {
    margin: 0 0 18px;
    color: var(--muted);
    max-width: 440px;
    font-size: 13px;
  }

  .cmd-strip {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 5px 5px 5px 12px;
    border-radius: var(--radius-card);
    background: var(--term-bg);
    border: 1px solid var(--line-strong);
    color: #F2EFE8;
  }

  .cmd-strip code {
    font-size: 12.5px;
    color: #F2EFE8;
  }

  .prompt {
    color: var(--brand-green);
    margin-right: 4px;
  }

  .copy-btn {
    height: 26px;
    padding: 0 9px;
    font-size: 11.5px;
  }

  @media (max-width: 640px) {
    .wrap { padding: 14px 12px 44px; gap: 14px; }
    .head { align-items: flex-start; flex-direction: column; }
  }
</style>
