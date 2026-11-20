<script>
  import { onMount } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { app, start, go, projectHash, settingsHash, toggleTheme, loadGlobalRoster } from './lib/store.svelte.js'
  import { t, lang, setLang, loginStatusLabel } from './lib/i18n.svelte.js'
  import { buildCrewTelemetry } from './lib/roster-metrics.js'
  import { isLiveWorking, localTime } from './lib/format.js'
  import Icon from './components/Icon.svelte'
  import SegMeter from './components/SegMeter.svelte'
  import Home from './components/Home.svelte'
  import Board from './components/Board.svelte'
  import Settings from './components/Settings.svelte'

  onMount(start)

  let switcherOpen = $state(false)
  let crewOpen = $state(false)

  let project = $derived(
    app.route.name === 'board'
      ? app.projects.find(p => p.id === app.route.id)
      : app.route.name === 'settings' && app.route.id !== 'global'
        ? app.projects.find(p => p.id === app.route.id)
        : null
  )

  let globalRunning = $derived(
    app.projects.reduce((sum, p) => {
      const loaded = app.tickets[p.id]
      const count = loaded
        ? loaded.reduce((n, tk) => n + (isLiveWorking(tk) ? 1 : 0), 0)
        : (p.runningCount ?? p.counts?.working ?? 0)
      return sum + count
    }, 0)
  )

  let crew = $derived(buildCrewTelemetry(app.roster, app.tickets))
  let inlineCrew = $derived(crew.slice(0, 3))
  let hasTightCrew = $derived(crew.some(c => c.tight || c.observed))

  function closeMenus() {
    switcherOpen = false
    crewOpen = false
  }

  function onWindowKeydown(e) {
    if (e.key === 'Escape') closeMenus()
  }

  function onWindowClick(e) {
    if (!e.target?.closest?.('.menu-anchor')) closeMenus()
  }

  function pickProject(id) {
    closeMenus()
    if (!id) go('')
    else if (app.route.name === 'settings') go(settingsHash(id))
    else go(projectHash(id))
  }

  $effect(() => {
    document.documentElement.lang = lang.current === 'zh' ? 'zh-CN' : 'en'
    document.title = project ? `${project.name} · broco` : 'broco'
  })
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<div class="shell" class:board-mode={app.route.name === 'board'}>
  <header class="top">
    <div class="left">
      <button class="brand" onclick={() => { closeMenus(); go('') }} aria-label="broco">
        <span class="mascot-wrap">
          <img class="logo" src="./broco-foreman-256.png" alt="" width="24" height="24" />
          {#if globalRunning > 0}
            <span class="live-badge pulse" aria-label={t('working')}></span>
          {/if}
        </span>
        <span class="name">broco</span>
      </button>

      {#if app.route.name === 'board' || app.route.name === 'settings'}
        <span class="sep" aria-hidden="true">/</span>
        <div class="menu-anchor">
          <button
            class="crumb-btn"
            aria-expanded={switcherOpen}
            title={t('switchProject')}
            onclick={() => { crewOpen = false; switcherOpen = !switcherOpen }}
          >
            <span class="crumb">
              {#if app.route.name === 'settings'}
                {project ? project.name : t('globalDefaults')}
              {:else}
                {project?.name ?? app.route.id}
              {/if}
            </span>
            <Icon name="chevronDown" size={13} />
          </button>

          {#if switcherOpen}
            <div class="popover switcher-menu" role="menu" transition:fade={{ duration: 110 }}>
              <button class="menu-item" role="menuitem" onclick={() => pickProject('')}>
                <Icon name="folder" size={13} />
                <span class="menu-label">{t('allProjects')}</span>
              </button>
              {#if app.route.name === 'settings'}
                <button
                  class="menu-item"
                  class:active={app.route.id === 'global'}
                  role="menuitem"
                  onclick={() => { closeMenus(); go('settings-global') }}
                >
                  <Icon name="sliders" size={13} />
                  <span class="menu-label">{t('globalDefaults')}</span>
                </button>
              {/if}
              {#if app.projects.length}
                <div class="menu-div"></div>
                {#each app.projects as p (p.id)}
                  {@const r = p.runningCount ?? p.counts?.working ?? 0}
                  <button
                    class="menu-item"
                    class:active={project?.id === p.id}
                    role="menuitem"
                    onclick={() => pickProject(p.id)}
                  >
                    <span class="menu-dot" class:working={r > 0} class:attn={r === 0 && p.attention > 0}></span>
                    <span class="menu-label">{p.name}</span>
                    {#if r > 0}
                      <span class="menu-meta mono working">{r}</span>
                    {:else if p.attention > 0}
                      <span class="menu-meta mono warn">{p.attention}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
        {#if app.route.name === 'settings'}
          <span class="sep" aria-hidden="true">/</span>
          <span class="crumb-tag">{t('settings')}</span>
        {/if}
      {/if}
    </div>

    <div class="center menu-anchor">
      {#if crew.length > 0}
        <div class="telemetry-inline" role="button" tabindex="0" aria-label={t('crewTelemetry')} aria-expanded={crewOpen}
          onclick={() => { switcherOpen = false; crewOpen = !crewOpen }}
          onkeydown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), switcherOpen = false, crewOpen = !crewOpen)}
        >
          {#each inlineCrew as item (item.id)}
            <span class="tele-item" class:tight={item.tight} class:working={item.isWorking} title={item.id}>
              <span class="tele-dot" class:working={item.isWorking} class:err={item.tight} class:ok={!item.tight && !item.isWorking && item.isReady}></span>
              <span class="tele-name mono">{item.shortName}</span>
              <SegMeter used={item.usedPercent} size="sm" />
              <span class="tele-pct mono" class:err={item.tight} class:warn={!item.tight && item.tone === 'warn'}>
                {item.observed ? t('quotaObsShort') : item.usedPercent !== null ? `${item.usedPercent}%` : '—'}
              </span>
            </span>
          {/each}
          {#if crew.length > inlineCrew.length}
            <span class="tele-more mono">+{crew.length - inlineCrew.length}</span>
          {/if}
        </div>

        <button
          class="crew-badge"
          class:tight={hasTightCrew}
          aria-expanded={crewOpen}
          onclick={() => { switcherOpen = false; crewOpen = !crewOpen }}
        >
          <span class="tele-dot" class:err={hasTightCrew} class:working={!hasTightCrew && globalRunning > 0} class:ok={!hasTightCrew && globalRunning === 0}></span>
          <span>{t('crew')}</span>
          <span class="mono">{crew.length}</span>
        </button>

        {#if crewOpen}
          <div class="popover crew-popover" transition:fade={{ duration: 110 }}>
            <div class="pop-head">
              <span class="pop-title">{t('crewTelemetry')}</span>
              <div class="pop-actions">
                <button class="pop-btn" onclick={() => loadGlobalRoster(true)} title={t('refresh')}>
                  <Icon name="refresh" size={12} />
                </button>
                <button class="pop-btn" onclick={() => { closeMenus(); go(settingsHash(project?.id || 'global')) }}>
                  {t('openSettings')}
                </button>
              </div>
            </div>
            <div class="pop-list">
              {#each crew as item (item.id)}
                <div class="pop-row" class:tight={item.tight}>
                  <div class="pop-left">
                    <span class="tele-dot" class:working={item.isWorking} class:err={item.tight} class:ok={!item.tight && !item.isWorking && item.isReady}></span>
                    <span class="mono pop-id" title={item.id}>{item.id}</span>
                    {#if item.isWorking}<span class="chip working">{t('working')}</span>{/if}
                    {#if item.isDefault}<span class="chip accent">{t('defaultBadge')}</span>{/if}
                  </div>
                  <div class="pop-right">
                    <SegMeter used={item.usedPercent} size="sm" />
                    <span class="mono pop-val" class:err={item.tight} class:warn={!item.tight && item.tone === 'warn'}>
                      {#if item.observed}
                        {t('quotaObsShort')}
                      {:else if item.usedPercent !== null}
                        {item.usedPercent}%{#if item.windowLabel} <span class="pop-win">{item.windowLabel}</span>{/if}
                      {:else}
                        {loginStatusLabel(item.worker.installed, item.worker.loginStatus)}
                      {/if}
                    </span>
                  </div>
                  {#if item.resetsAt}
                    <div class="pop-reset mono">{t('quotaResets')}{localTime(item.resetsAt, { year: false })}</div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <div class="right">
      <button
        class="tool-btn"
        class:active={app.route.name === 'settings'}
        onclick={() => { closeMenus(); go(settingsHash(project?.id || 'global')) }}
      >
        <Icon name="sliders" size={13} />
        <span class="tool-label">{t('settings')}</span>
      </button>
      <button
        class="icon-btn"
        onclick={toggleTheme}
        title={`${t('themeSwitch')} (${app.theme === 'dark' ? t('themeLight') : t('themeDark')})`}
        aria-label={t('themeSwitch')}
      >
        <Icon name={app.theme === 'dark' ? 'sun' : 'moon'} size={15} />
      </button>
      <button
        class="tool-btn lang-btn mono"
        onclick={() => setLang(lang.current === 'zh' ? 'en' : 'zh')}
        title={t('langSwitch')}
      >
        {lang.current === 'zh' ? 'EN' : '中'}
      </button>
    </div>
  </header>

  {#if !app.connected && (app.everConnected || app.connectionFailed)}
    <div class="offline" transition:fade={{ duration: 130 }}>
      <Icon name="refresh" size={13} /> {t('offline')}
    </div>
  {/if}

  <main>
    {#if app.route.name === 'settings'}
      {#key app.route.id}<Settings scope={app.route.id} />{/key}
    {:else if app.route.name === 'board'}
      {#key app.route.id}
        <Board id={app.route.id} />
      {/key}
    {:else}
      <Home />
    {/if}
  </main>

  {#if app.toast?.message}
    {#key app.toast.id}
      <div class="toast-wrap">
        <div class="toast {app.toast.kind}" role="status" in:fly={{ y: 10, duration: 140 }} out:fade={{ duration: 120 }}>
          {#if app.toast.kind === 'error'}<Icon name="alert" size={14} />{:else}<Icon name="check" size={14} />{/if}
          <span>{app.toast.message}</span>
        </div>
      </div>
    {/key}
  {/if}
</div>

<style>
  .shell {
    min-height: 100vh;
    overflow-x: clip;
    display: flex;
    flex-direction: column;
  }

  .shell.board-mode {
    height: 100dvh;
    max-height: 100dvh;
    overflow: hidden;
  }

  .top {
    position: sticky;
    top: 0;
    z-index: 30;
    flex: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 18px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: saturate(1.2) blur(10px);
    border-bottom: 1px solid var(--line);
  }

  .left {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .center {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }

  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.025em;
    flex: none;
  }

  .mascot-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex: none;
  }

  .logo {
    width: 24px;
    height: 24px;
    display: block;
    image-rendering: pixelated;
    filter: var(--mascot-outline);
  }

  .live-badge {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-working);
    border: 1.5px solid var(--surface);
  }

  .sep {
    color: var(--faint);
    font-family: var(--mono);
    font-size: 12px;
    flex: none;
  }

  .menu-anchor {
    position: relative;
    min-width: 0;
  }

  .crumb-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    max-width: 220px;
    padding: 0 8px;
    border-radius: var(--radius-card);
    border: 1px solid transparent;
    font-weight: 600;
    font-size: 13px;
    color: var(--ink);
    transition: background 0.12s, border-color 0.12s;
  }
  .crumb-btn:hover {
    background: var(--surface-raise);
    border-color: var(--line);
  }

  .crumb {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .crumb-tag {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    white-space: nowrap;
  }

  .telemetry-inline {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .telemetry-inline:hover {
    border-color: var(--line-strong);
    background: var(--surface-raise);
  }

  .tele-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }

  .tele-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--faint);
    flex: none;
  }
  .tele-dot.ok { background: var(--brand-green); }
  .tele-dot.working { background: var(--status-working); }
  .tele-dot.err { background: var(--status-danger); }

  .tele-name {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink);
    max-width: 82px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tele-pct {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    min-width: 28px;
    text-align: right;
  }
  .tele-pct.err { color: var(--status-danger); }
  .tele-pct.warn { color: var(--status-review); }

  .tele-more {
    font-size: 11px;
    font-weight: 600;
    color: var(--faint);
    padding-left: 4px;
    border-left: 1px solid var(--line);
  }

  .crew-badge {
    display: none;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 9px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
  }
  .crew-badge:hover {
    border-color: var(--line-strong);
    background: var(--surface-raise);
  }
  .crew-badge.tight {
    border-color: color-mix(in srgb, var(--status-danger) 45%, var(--line));
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    z-index: 50;
    border-radius: var(--radius-panel);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    box-shadow: var(--popover-shadow);
  }

  .switcher-menu {
    left: 0;
    min-width: 220px;
    max-width: 300px;
    padding: 5px;
  }

  .menu-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: var(--radius-card);
    font-size: 12.5px;
    font-weight: 560;
    color: var(--ink);
    text-align: left;
  }
  .menu-item:hover { background: var(--surface-raise); }
  .menu-item.active {
    background: var(--brand-soft);
    color: var(--brand-green);
  }

  .menu-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--faint);
    flex: none;
  }
  .menu-dot.working { background: var(--status-working); }
  .menu-dot.attn { background: var(--status-review); }

  .menu-meta {
    font-size: 11px;
    font-weight: 650;
  }
  .menu-meta.working { color: var(--status-working); }
  .menu-meta.warn { color: var(--status-review); }

  .menu-div {
    height: 1px;
    background: var(--line);
    margin: 4px 0;
  }

  .crew-popover {
    left: 50%;
    transform: translateX(-50%);
    width: min(380px, calc(100vw - 24px));
    padding: 10px 12px;
  }

  .pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }

  .pop-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .pop-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pop-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border-radius: var(--radius-chip);
    border: 1px solid var(--line);
    background: var(--surface-recessed);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }
  .pop-btn:hover { color: var(--ink); border-color: var(--line-strong); }

  .pop-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 320px;
    overflow-y: auto;
  }

  .pop-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 4px 10px;
    padding: 6px 8px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
  }
  .pop-row.tight {
    background: var(--danger-tint);
    border-color: color-mix(in srgb, var(--status-danger) 40%, var(--line));
  }

  .pop-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .pop-id {
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pop-right {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .pop-val {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    min-width: 56px;
    text-align: right;
  }
  .pop-val.err { color: var(--status-danger); }
  .pop-val.warn { color: var(--status-review); }

  .pop-win {
    color: var(--faint);
    font-size: 10.5px;
  }

  .pop-reset {
    grid-column: 1 / -1;
    font-size: 10.5px;
    color: var(--faint);
    padding-left: 12px;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 9px;
    border-radius: var(--radius-card);
    border: 1px solid var(--line);
    background: var(--surface-recessed);
    color: var(--ink);
    font-size: 12px;
    font-weight: 600;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .tool-btn:hover {
    background: var(--surface-raise);
    border-color: var(--line-strong);
  }
  .tool-btn.active {
    background: var(--brand-soft);
    border-color: color-mix(in srgb, var(--brand-green) 42%, var(--line));
    color: var(--brand-green);
  }

  .lang-btn {
    min-width: 32px;
    justify-content: center;
    padding: 0 7px;
    font-size: 11.5px;
  }

  .offline {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 6px 14px;
    font-size: 12.5px;
    background: var(--review-soft);
    color: var(--status-review);
    border-bottom: 1px solid var(--line);
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    width: 100%;
  }

  .toast-wrap {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 22px;
    z-index: 60;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(520px, calc(100vw - 28px));
    padding: 9px 14px;
    border-radius: var(--radius-panel);
    background: var(--surface-raise);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    box-shadow: var(--popover-shadow);
    font-size: 12.5px;
    font-weight: 560;
  }
  .toast.error {
    background: var(--status-danger);
    border-color: var(--status-danger);
    color: #fff;
  }

  @media (max-width: 1180px) {
    .telemetry-inline { display: none; }
    .crew-badge { display: inline-flex; }
  }

  @media (max-width: 640px) {
    .top { padding: 0 12px; gap: 6px; }
    .tool-label { display: none; }
    .crumb-btn { max-width: 130px; }
  }
</style>
