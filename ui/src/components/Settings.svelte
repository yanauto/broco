<script>
  import { onMount } from 'svelte'
  import { app, copyText, go, loadGlobalRoster, settingsHash, toast } from '../lib/store.svelte.js'
  import { request } from '../lib/api.js'
  import { loginStatusLabel, t, tf } from '../lib/i18n.svelte.js'
  import { localTime, pickLocalTime, windowName } from '../lib/format.js'
  import Icon from './Icon.svelte'
  import SegMeter from './SegMeter.svelte'

  let { scope } = $props()
  let config = $state(null)
  let roster = $state(null)
  let loading = $state(true)
  let working = $state('')
  let error = $state('')
  let hideReverted = $state(false)
  let copiedCmd = $state('')
  let lastSettingsTick = app.settingsTick
  let lastReconnectTick = app.reconnectTick

  let customId = $state('custom:my-cli')
  let templateText = $state('{}')
  let customModels = $state('')
  let customEfforts = $state('')
  let trialStatus = $state('')
  let trialPassed = $state(false)

  const cliQuickCommands = [
    'broco set concurrency <n>',
    'broco allow <bros>',
    'broco defaults <bro> --model <id>',
    'broco rules --add "..."',
    'broco note <bro> "..."',
    'broco undo'
  ]

  let effective = $derived(config?.effective ?? {
    allow: config?.allow ?? [],
    worker: config?.worker ?? '',
    concurrency: config?.effectiveConcurrency ?? 3,
    entries: config?.entries ?? {},
    rules: config?.rules ?? []
  })

  let allowedIds = $derived(effective.allow ?? [])
  let defaultBro = $derived(effective.worker || '')
  let concurrency = $derived(effective.concurrency ?? config?.effectiveConcurrency ?? 3)
  let activeRules = $derived(effective.rules ?? [])
  let auditRows = $derived(config?.audit ?? [])
  let visibleAuditRows = $derived(
    hideReverted ? auditRows.filter(item => !item.revertedAt) : auditRows
  )
  let revertedCount = $derived(auditRows.filter(item => !!item.revertedAt).length)

  let prominentWorkers = $derived.by(() => {
    const list = roster?.workers ?? []
    if (allowedIds.length) {
      return allowedIds.map(id => list.find(w => w.id === id) ?? {
        id,
        cli: id.startsWith('pi:') ? 'pi' : id.startsWith('custom:') ? (effective.entries?.[id]?.template?.command || 'custom') : id,
        allowed: true,
        installed: false,
        capability: id.startsWith('custom:') ? 'degraded' : 'full',
        loginStatus: 'unknown',
        models: [],
        warnings: []
      })
    }
    if (scope === 'global') {
      return list.filter(w => ['claude', 'codex', 'agy', 'cursor-agent'].includes(w.id) || Object.prototype.hasOwnProperty.call(effective.entries ?? {}, w.id))
    }
    return []
  })

  let disallowedIds = $derived.by(() => {
    const shown = new Set(prominentWorkers.map(w => w.id))
    const all = [...new Set([...(roster?.workers ?? []).map(w => w.id), ...Object.keys(effective.entries ?? {})])]
    return all.filter(id => !shown.has(id))
  })

  let hasUntestedCustom = $derived(allowedIds.some(id => id.startsWith('custom:') && !effective.entries?.[id]?.template))

  function normalizeWindows(windows) {
    return (windows || []).filter(win => Number.isFinite(win?.usedPercent)).map(win => ({
      label: windowName(win.minutes, win.window || win.name || ''),
      usedPercent: Math.round(win.usedPercent),
      reset: win.resetsAt ? localTime(win.resetsAt, { year: false }) : ''
    }))
  }

  function quotaModel(w) {
    const q = w?.quota
    if (!q) return { mode: 'unreported', tone: 'muted', badge: '', rows: [], groups: [], reset: '' }
    if (q.source === 'observed') {
      return {
        mode: 'observed',
        tone: 'err',
        badge: t('quotaAvoid'),
        rows: [],
        groups: [],
        reset: q.resetsAt ? localTime(q.resetsAt, { year: false }) : ''
      }
    }
    const multiGroups = Array.isArray(q.groups) && q.groups.length > 1
      ? q.groups.map(g => ({ name: g.name, rows: normalizeWindows(g.windows) })).filter(g => g.rows.length)
      : []
    const topRows = normalizeWindows(q.windows)
    const allRows = multiGroups.length ? multiGroups.flatMap(g => g.rows) : topRows
    const maxPct = allRows.reduce((m, r) => Math.max(m, r.usedPercent), -1)
    const avoid = Boolean(q.avoid || q.reached || maxPct >= 85)
    const warn = !avoid && maxPct >= 60
    const plentiful = !avoid && !warn && Boolean(q.plentiful)
    const tone = avoid ? 'err' : warn ? 'warn' : plentiful ? 'ok' : 'normal'
    const badge = avoid ? t('quotaAvoid') : plentiful ? t('quotaPlentiful') : ''

    if (multiGroups.length > 1) {
      return { mode: 'groups', tone, badge, rows: [], groups: multiGroups, reset: '' }
    }
    if (topRows.length) {
      return { mode: 'windows', tone, badge, rows: topRows, groups: [], reset: '' }
    }
    return { mode: 'unreported', tone: 'muted', badge: '', rows: [], groups: [], reset: '' }
  }

  function hiddenCount(id, w) {
    const configured = effective.entries?.[id]?.hiddenModels ?? []
    const detectedHidden = (w?.models ?? []).filter(m => m.hidden).length
    return Math.max(configured.length, detectedHidden)
  }

  function syncCustomDraft(id) {
    const entry = config?.entries?.[id] ?? effective.entries?.[id] ?? {}
    const tpl = entry.template ?? config?.presets?.[id] ?? {}
    templateText = JSON.stringify(tpl, null, 2)
    customModels = (entry.models ?? []).join('\n')
    customEfforts = (entry.efforts ?? []).join('\n')
    trialStatus = ''
    trialPassed = false
  }

  async function copyCli(cmd) {
    const ok = await copyText(cmd, `${t('copied')}: ${cmd}`)
    if (ok) {
      copiedCmd = cmd
      setTimeout(() => { if (copiedCmd === cmd) copiedCmd = '' }, 1300)
    }
  }

  async function load(forceRefresh = false) {
    error = ''
    loading = true
    try {
      const [cfg, rst] = await Promise.all([
        request('GET', '/api/settings/' + encodeURIComponent(scope)),
        request('GET', '/api/roster/' + encodeURIComponent(scope) + (forceRefresh ? '?refresh=1' : ''))
      ])
      config = cfg
      roster = rst
      if (scope === 'global') {
        app.roster = rst
        app.rosterLoadedAt = Date.now()
      }
      const existingCustom = Object.keys(cfg.entries ?? {}).find(k => k.startsWith('custom:'))
      if (existingCustom && customId === 'custom:my-cli') customId = existingCustom
      syncCustomDraft(customId)
    } catch (e) {
      if (e.status === 404 || e.code === 'PROJECT_NOT_FOUND') {
        go('settings-global')
        return
      }
      error = e.message
    } finally {
      loading = false
    }
  }

  onMount(() => { load(false) })

  $effect(() => {
    const st = app.settingsTick
    const rt = app.reconnectTick
    if (st !== lastSettingsTick || rt !== lastReconnectTick) {
      lastSettingsTick = st
      lastReconnectTick = rt
      Promise.all([
        request('GET', '/api/settings/' + encodeURIComponent(scope)),
        request('GET', '/api/roster/' + encodeURIComponent(scope))
      ]).then(([cfg, rst]) => {
        config = cfg
        roster = rst
      }).catch(e => {
        if (e.status === 404 || e.code === 'PROJECT_NOT_FOUND') go('settings-global')
      })
    }
  })

  async function undo(id = null) {
    const key = id ? 'undo-' + id : 'undo-latest'
    working = key
    error = ''
    try {
      const res = await request('POST', '/api/audit/' + encodeURIComponent(scope) + '/undo', id ? { id } : {})
      config = res.config
      roster = await request('GET', '/api/roster/' + encodeURIComponent(scope))
      loadGlobalRoster(true)
      toast(t('revertedToast') + res.summary)
    } catch (e) {
      error = e.message
    } finally {
      working = ''
    }
  }

  async function cliAction(worker, kind) {
    working = worker.id + ':' + kind
    error = ''
    try {
      const target = worker.id.startsWith('custom:') ? worker.id : (worker.cli || worker.id)
      await request('POST', '/api/cli/' + encodeURIComponent(target) + '/' + kind, {
        projectId: scope === 'global' ? undefined : scope
      })
      toast(t('openedTerminal'))
    } catch (e) {
      error = e.message
    } finally {
      working = ''
    }
  }

  function lines(text) {
    return text.split('\n').map(s => s.trim()).filter(Boolean)
  }

  async function runTrial() {
    working = 'trial'
    error = ''
    trialStatus = ''
    trialPassed = false
    try {
      const id = customId.trim()
      if (!/^custom:[a-z0-9][a-z0-9_.-]*$/.test(id)) {
        throw new Error(t('customIdInvalid'))
      }
      const template = JSON.parse(templateText)
      const modelList = lines(customModels)
      const effortList = lines(customEfforts)
      const result = await request('POST', '/api/templates/' + encodeURIComponent(scope) + '/test', {
        template,
        model: modelList[0],
        effort: effortList[0]
      })
      trialPassed = true
      trialStatus = tf('trialPassedMsg', { session: result.session })
    } catch (e) {
      error = e.message
    } finally {
      working = ''
    }
  }

  async function saveCustomTemplate() {
    working = 'save-custom'
    error = ''
    try {
      const id = customId.trim()
      if (!/^custom:[a-z0-9][a-z0-9_.-]*$/.test(id)) {
        throw new Error(t('customIdInvalid'))
      }
      const template = JSON.parse(templateText)
      const latest = await request('GET', '/api/settings/' + encodeURIComponent(scope))
      const payload = {
        revision: latest.revision,
        allow: latest.allow,
        worker: latest.worker,
        concurrency: latest.concurrency ?? undefined,
        rules: latest.rules ?? [],
        rulesOverride: !!latest.rulesOverride,
        inheritPolicy: !!latest.inheritPolicy,
        entries: {
          ...(latest.entries ?? {}),
          [id]: {
            ...(latest.entries?.[id] ?? {}),
            template,
            models: lines(customModels),
            efforts: lines(customEfforts)
          }
        }
      }
      config = await request('POST', '/api/settings/' + encodeURIComponent(scope), payload)
      roster = await request('GET', '/api/roster/' + encodeURIComponent(scope))
      loadGlobalRoster(true)
      trialPassed = false
      trialStatus = tf('savedVerifiedMsg', { id })
      toast(trialStatus)
    } catch (e) {
      error = e.message
    } finally {
      working = ''
    }
  }
</script>

<section class="settings">
  <div class="heading">
    <div>
      <p class="eyebrow mono">BROCO / {t('settingsEyebrow')}</p>
      <h1>{t('settingsTitle')}</h1>
    </div>
    <div class="controls">
      <label class="scope-picker">
        <span>{t('scopeLabel')}</span>
        <select value={scope} onchange={e => go(settingsHash(e.currentTarget.value))}>
          <option value="global">{t('globalDefaults')}</option>
          {#each app.projects as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
      <button class="btn btn-keycap" disabled={loading || !!working} onclick={() => load(true)}>
        <Icon name="refresh" size={13} />
        <span>{loading ? t('refreshing') : t('refresh')}</span>
      </button>
    </div>
  </div>

  <details class="cli-bar">
    <summary class="cli-summary">
      <span class="cli-lead">
        <Icon name="terminal" size={14} />
        <strong>{t('cliCommands')}</strong>
        <span class="cli-hint">{t('clickToCopy')}</span>
      </span>
      <span class="cli-preview mono">broco allow · broco defaults · broco undo</span>
    </summary>
    <div class="cli-body">
      <p class="callout-title">{t('settingsCallout')}</p>
      <div class="cli-pills mono">
        {#each cliQuickCommands as cmd}
          <button class="cli-pill" class:copied={copiedCmd === cmd} onclick={() => copyCli(cmd)} title={t('copyCmd')}>
            <Icon name={copiedCmd === cmd ? 'check' : 'copy'} size={11} />
            <span>{cmd}</span>
          </button>
        {/each}
      </div>
    </div>
  </details>

  {#if error}
    <p class="error-banner" role="alert">{error}</p>
  {/if}

  {#if config}
    <section class="panel">
      <div class="panel-head">
        <h2>{t('dispatchPolicy')}</h2>
        {#if scope !== 'global' && config.inheritPolicy}
          <span class="chip">{t('inheritsGlobalAllow')}</span>
        {/if}
      </div>

      <div class="policy-grid">
        <div class="stat-box">
          <span class="stat-label">{t('allowedBros')}</span>
          <div class="badges">
            {#if allowedIds.length}
              {#each allowedIds as id}
                <span class="bro-badge" class:is-default={id === defaultBro}>
                  <span class="mono">{id}</span>
                  {#if id === defaultBro}
                    <em class="default-tag">{t('defaultBadge')}</em>
                  {/if}
                </span>
              {/each}
            {:else}
              <span class="muted">{t('noneConfigured')}</span>
            {/if}
          </div>
        </div>

        <div class="stat-box">
          <span class="stat-label">{t('defaultBro')}</span>
          <div class="stat-value mono">{defaultBro || t('noneValue')}</div>
        </div>

        <div class="stat-box">
          <span class="stat-label">{t('concurrency')}</span>
          <div class="stat-value">
            <span class="num mono">{concurrency}</span>
            <span class="sub-hint">
              {#if config.concurrency !== null && config.concurrency !== undefined}
                {scope === 'global' ? t('globalSetting') : t('projectOverride')}
              {:else}
                {t('inheritedDefault')}
              {/if}
            </span>
          </div>
        </div>
      </div>

      <div class="rules-block">
        <div class="rules-head">
          <span class="stat-label">{t('activeRules')}</span>
          {#if scope !== 'global' && config.rulesOverride}
            <span class="chip">{t('overridesGlobalRules')}</span>
          {/if}
        </div>
        {#if activeRules.length}
          <ul class="rules-list">
            {#each activeRules as rule}
              <li>{rule}</li>
            {/each}
          </ul>
        {:else}
          <p class="muted-line">{t('noActiveRules')}</p>
        {/if}
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>{t('allowedWorkers')}</h2>
        <span class="muted-meta mono">{tf('shownCount', { n: prominentWorkers.length })}</span>
      </div>

      {#if loading && !roster}
        <p class="muted-line">{t('inspectingWorkers')}</p>
      {:else if prominentWorkers.length === 0}
        <p class="muted-line">{t('noAllowedWorkers')}</p>
      {:else}
        <div class="worker-grid">
          {#each prominentWorkers as w (w.id)}
            {@const q = quotaModel(w)}
            {@const hiddenN = hiddenCount(w.id, w)}
            {@const effEntry = effective.entries?.[w.id] ?? {}}
            {@const defModel = w.defaultBlocked ? t('hiddenChooseAnother') : (effEntry.model || w.defaultModel || t('cliDefault'))}
            {@const defEffort = effEntry.effort || w.defaultEffort || t('cliDefault')}
            {@const noteText = effEntry.note || w.note || ''}
            <article class="worker-card" class:tight={q.tone === 'err'}>
              <div class="worker-top">
                <div class="worker-id-group">
                  <strong class="mono worker-id">{w.id}</strong>
                  {#if w.id === defaultBro}
                    <span class="chip accent">{t('defaultBadge')}</span>
                  {/if}
                  <span class="chip">{w.capability === 'degraded' ? t('customTemplateTag') : t('nativeTag')}</span>
                </div>
                <span class="status-pill" class:ok={w.installed && (w.loginStatus === 'ready' || w.loginStatus === 'not-required')} class:warn={w.loginStatus === 'signed-out' || w.loginStatus === 'expired' || !w.installed}>
                  {loginStatusLabel(w.installed, w.loginStatus)}
                </span>
              </div>

              <dl class="worker-meta">
                <div>
                  <dt>{t('cliVersion')}</dt>
                  <dd class="mono">{w.cli || w.id}{w.version ? ' · ' + w.version : ''}</dd>
                </div>
                <div>
                  <dt>{t('defaultModelEffort')}</dt>
                  <dd class="mono">{defModel} · {defEffort}</dd>
                </div>
                <div class="span-2">
                  <dt class="quota-dt">
                    <span>{t('quotaLabel')}</span>
                    {#if q.badge}
                      <span class="chip" class:err={q.tone === 'err'} class:ok={q.tone === 'ok'} class:warn={q.tone === 'warn'}>{q.badge}</span>
                    {/if}
                  </dt>
                  <dd class="quota-dd">
                    {#if q.mode === 'observed'}
                      <div class="qm-row">
                        <SegMeter used={100} size="md" />
                        <span class="qm-txt err">{t('quotaObserved')}{#if q.reset} · {t('quotaResets')}{q.reset}{/if}</span>
                      </div>
                    {:else if q.mode === 'groups'}
                      <div class="qm-groups">
                        {#each q.groups as g}
                          <div class="qm-group">
                            <span class="qm-gname">{g.name}</span>
                            <div class="qm-rows">
                              {#each g.rows as r}
                                <div class="qm-row">
                                  <span class="qm-win mono">{r.label}</span>
                                  <SegMeter used={r.usedPercent} size="sm" />
                                  <span class="qm-pct mono" class:err={r.usedPercent >= 85} class:warn={r.usedPercent >= 60 && r.usedPercent < 85}>{r.usedPercent}%</span>
                                  {#if r.reset}<span class="qm-reset mono">{r.reset}</span>{/if}
                                </div>
                              {/each}
                            </div>
                          </div>
                        {/each}
                      </div>
                    {:else if q.mode === 'windows'}
                      <div class="qm-rows">
                        {#each q.rows as r}
                          <div class="qm-row">
                            <span class="qm-win mono">{r.label}</span>
                            <SegMeter used={r.usedPercent} size="md" />
                            <span class="qm-pct mono" class:err={r.usedPercent >= 85} class:warn={r.usedPercent >= 60 && r.usedPercent < 85}>{r.usedPercent}%</span>
                            {#if r.reset}<span class="qm-reset mono">{r.reset}</span>{/if}
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <div class="qm-row">
                        <SegMeter used={null} size="md" />
                        <span class="qm-txt muted">{t('quotaUnreported')}</span>
                      </div>
                    {/if}
                  </dd>
                </div>
                {#if noteText}
                  <div class="span-2">
                    <dt>{t('note')}</dt>
                    <dd>{noteText}</dd>
                  </div>
                {/if}
                {#if hiddenN > 0}
                  <div class="span-2">
                    <dt>{t('hiddenFamilies')}</dt>
                    <dd class="mono">{hiddenN}{(effEntry.hiddenModels ?? []).length ? ' (' + effEntry.hiddenModels.join(', ') + ')' : ''}</dd>
                  </div>
                {/if}
              </dl>

              {#if w.recentProblem}
                <p class="worker-warn mono">{w.recentProblem.class}: {w.recentProblem.message}</p>
              {/if}
              {#each w.warnings ?? [] as warning}
                <p class="worker-notice">{warning}</p>
              {/each}

              {#if w.install || w.upgrade || w.login}
                <div class="worker-actions">
                  {#if !w.installed && w.install}
                    <button class="btn btn-ghost sm-btn" disabled={!!working} onclick={() => cliAction(w, 'install')}>
                      <Icon name="terminal" size={12} />
                      <span>{t('installTerminal')}</span>
                    </button>
                  {:else if w.installed && w.upgrade}
                    <button class="btn btn-ghost sm-btn" disabled={!!working} onclick={() => cliAction(w, 'upgrade')}>
                      <Icon name="terminal" size={12} />
                      <span>{t('upgradeTerminal')}</span>
                    </button>
                  {/if}
                  {#if w.installed && w.login && w.loginStatus !== 'not-required'}
                    <button class="btn btn-ghost sm-btn" disabled={!!working} onclick={() => cliAction(w, 'login')}>
                      <Icon name="key" size={12} />
                      <span>{t('loginTerminal')}</span>
                    </button>
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}

      {#if disallowedIds.length}
        <p class="disallowed-line">
          <span>{t('disallowedInScope')}</span>
          <span class="mono">{disallowedIds.join(', ')}</span>
        </p>
      {/if}
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>{t('auditLog')}</h2>
        <div class="audit-tools">
          {#if revertedCount > 0}
            <label class="toggle-check">
              <input type="checkbox" bind:checked={hideReverted} />
              <span>{t('hideReverted')}</span>
              <span class="mono toggle-n">{revertedCount}</span>
            </label>
          {/if}
          {#if auditRows.some(a => !a.revertedAt && a.action !== 'undo')}
            <button class="btn btn-primary sm-btn undo-latest-btn" disabled={!!working} onclick={() => undo(null)}>
              <Icon name="undo" size={13} />
              <span>{working === 'undo-latest' ? t('reverting') : t('undoLatest')}</span>
            </button>
          {/if}
        </div>
      </div>

      {#if visibleAuditRows.length === 0}
        <p class="muted-line">{t('noAuditChanges')}</p>
      {:else}
        <div class="audit-table-wrap">
          <table class="audit-table">
            <thead>
              <tr>
                <th>{t('auditTime')}</th>
                <th>{t('auditActor')}</th>
                <th>{t('auditSummary')}</th>
                <th class="right-col">{t('auditAction')}</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleAuditRows as item (item.id)}
                {@const isAgent = item.actor === 'agent'}
                <tr class:is-reverted={!!item.revertedAt}>
                  <td class="mono time-cell" title={item.at ? localTime(item.at, { seconds: true, suffix: true }) : (item.atLocal ?? item.atAsia ?? '')}>
                    {pickLocalTime(item.atLocal, item.atAsia, item.at, { seconds: true })}
                  </td>
                  <td>
                    <span class="actor-chip mono" class:is-agent={isAgent} class:is-user={!isAgent}>
                      {isAgent ? t('agentActor') : (item.actor === 'user' ? t('userActor') : item.actor)}
                    </span>
                  </td>
                  <td class="summary-cell">
                    <span class="action-tag mono">{item.action}</span>
                    <span>{item.summary}</span>
                  </td>
                  <td class="right-col">
                    {#if item.revertedAt}
                      <span class="reverted-label" title={pickLocalTime(item.revertedAtLocal, item.revertedAtAsia, item.revertedAt, { seconds: true })}>{t('reverted')}</span>
                    {:else if item.action !== 'undo'}
                      <button class="btn btn-ghost sm-btn" disabled={!!working} onclick={() => undo(item.id)}>
                        {working === 'undo-' + item.id ? t('reverting') : t('undo')}
                      </button>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <details class="panel custom-details" open={hasUntestedCustom}>
      <summary class="custom-summary">
        <span>{t('customTrialTitle')}</span>
        <span class="muted-meta">{t('customTrialHint')}</span>
      </summary>
      <div class="custom-body">
        <div class="custom-grid">
          <label>
            <span>{t('customWorkerId')}</span>
            <input bind:value={customId} onchange={() => syncCustomDraft(customId)} placeholder="custom:my-cli" />
          </label>
          <label>
            <span>{t('loadPreset')}</span>
            <select value="" onchange={e => { customId = e.currentTarget.value; templateText = JSON.stringify(config.presets[e.currentTarget.value], null, 2); trialStatus = ''; trialPassed = false }}>
              <option value="" disabled>{t('choosePreset')}</option>
              {#each Object.keys(config.presets ?? {}) as presetId}
                <option value={presetId}>{presetId}</option>
              {/each}
            </select>
          </label>
        </div>
        <label>
          <span>{t('templateJson')}</span>
          <textarea class="mono" rows="10" bind:value={templateText} oninput={() => { trialPassed = false; trialStatus = '' }}></textarea>
        </label>
        <div class="custom-grid">
          <label>
            <span>{t('customModelsLabel')}</span>
            <textarea class="mono" rows="2" bind:value={customModels}></textarea>
          </label>
          <label>
            <span>{t('customEffortsLabel')}</span>
            <textarea class="mono" rows="2" bind:value={customEfforts}></textarea>
          </label>
        </div>
        <div class="custom-actions">
          <button class="btn btn-keycap" disabled={!!working} onclick={runTrial}>
            {working === 'trial' ? t('testingTwoTurns') : t('testNewAndResume')}
          </button>
          {#if trialPassed}
            <button class="btn btn-primary" disabled={!!working} onclick={saveCustomTemplate}>
              {working === 'save-custom' ? t('saving') : t('saveVerifiedTemplate')}
            </button>
          {/if}
        </div>
        {#if trialStatus}
          <p class="trial-ok" role="status">{trialStatus}</p>
        {/if}
      </div>
    </details>
  {/if}
</section>

<style>
  .settings {
    width: 100%;
    max-width: 1120px;
    margin: 0 auto;
    padding: 20px 22px 56px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--brand-green);
    margin: 0 0 3px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0;
  }

  h2 {
    font-size: 14.5px;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.015em;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .scope-picker {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--muted);
  }

  .scope-picker select,
  .custom-body input,
  .custom-body select,
  .custom-body textarea {
    color: var(--ink);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    padding: 5px 10px;
    font: inherit;
    font-size: 12.5px;
  }

  .custom-body textarea {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    resize: vertical;
  }

  .cli-bar {
    border-radius: var(--radius-panel);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--card-highlight);
  }

  .cli-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 14px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .cli-summary::-webkit-details-marker { display: none; }

  .cli-lead {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--brand-green);
  }
  .cli-lead strong { color: var(--ink); font-weight: 650; }
  .cli-hint { color: var(--muted); font-size: 12px; }
  .cli-preview { color: var(--faint); font-size: 11px; }

  .cli-body {
    padding: 0 14px 12px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
  }

  .callout-title {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
  }

  .cli-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .cli-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    padding: 4px 9px;
    border-radius: var(--radius-chip);
    background: var(--term-bg);
    border: 1px solid var(--line-strong);
    color: #F2EFE8;
    box-shadow: var(--keycap);
    transition: border-color 0.12s, transform 0.08s;
  }
  .cli-pill:hover { border-color: var(--brand-green); }
  .cli-pill:active { transform: translateY(1px); box-shadow: none; }
  .cli-pill.copied { border-color: var(--brand-green); color: var(--brand-green); }

  .error-banner {
    margin: 0;
    padding: 10px 13px;
    border-radius: var(--radius-card);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--status-danger) 42%, var(--line));
    color: var(--status-danger);
    font-size: 12.5px;
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: 16px 18px;
    box-shadow: var(--card-highlight);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .policy-grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 10px;
  }

  .stat-box {
    padding: 10px 12px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .stat-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }

  .stat-value {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
  }

  .num { font-size: 19px; }

  .sub-hint {
    font-size: 11.5px;
    font-weight: 450;
    color: var(--muted);
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .bro-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
    font-size: 12px;
  }
  .bro-badge.is-default {
    border-color: color-mix(in srgb, var(--brand-green) 48%, var(--line));
    background: var(--brand-soft);
  }

  .default-tag {
    font-style: normal;
    font-size: 10px;
    font-weight: 700;
    color: var(--brand-green);
    text-transform: uppercase;
  }

  .rules-block {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rules-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .rules-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }

  .muted-line, .muted-meta {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }

  .worker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
  }

  .worker-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 13px 14px;
    border-radius: var(--radius-card);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
  }
  .worker-card.tight {
    background: var(--danger-tint);
    border-color: color-mix(in srgb, var(--status-danger) 48%, var(--line));
  }

  .worker-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .worker-id-group {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .worker-id {
    font-size: 13.5px;
    font-weight: 700;
  }

  .status-pill {
    flex: none;
    font-size: 11px;
    font-weight: 650;
    padding: 1px 7px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .status-pill.ok {
    background: var(--brand-soft);
    border-color: color-mix(in srgb, var(--brand-green) 36%, transparent);
    color: var(--brand-green);
  }
  .status-pill.warn {
    background: var(--review-soft);
    border-color: color-mix(in srgb, var(--status-review) 36%, transparent);
    color: var(--status-review);
  }

  .worker-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 10px;
    margin: 0;
  }
  .worker-meta div { min-width: 0; }
  .worker-meta .span-2 { grid-column: 1 / -1; }
  .worker-meta dt {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .worker-meta dd {
    margin: 0;
    font-size: 12px;
    color: var(--ink);
    word-break: break-word;
  }

  .quota-dt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .quota-dd {
    margin-top: 3px !important;
  }

  .qm-rows {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .qm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .qm-win {
    font-size: 11px;
    font-weight: 650;
    color: var(--muted);
    min-width: 34px;
  }

  .qm-pct {
    font-size: 11.5px;
    font-weight: 700;
    color: var(--ink);
    min-width: 34px;
  }
  .qm-pct.err { color: var(--status-danger); }
  .qm-pct.warn { color: var(--status-review); }

  .qm-reset {
    font-size: 10.5px;
    color: var(--faint);
  }

  .qm-txt {
    font-size: 11.5px;
  }
  .qm-txt.err { color: var(--status-danger); font-weight: 600; }
  .qm-txt.muted { color: var(--muted); }

  .qm-groups {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .qm-group {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    border-radius: var(--radius-chip);
    background: var(--surface);
    border: 1px solid var(--line);
  }

  .qm-gname {
    font-size: 11px;
    font-weight: 700;
    color: var(--ink);
  }

  .worker-warn {
    margin: 0;
    padding: 6px 8px;
    border-radius: var(--radius-chip);
    background: var(--danger-soft);
    color: var(--status-danger);
    font-size: 11.5px;
  }

  .worker-notice {
    margin: 0;
    font-size: 11.5px;
    color: var(--muted);
  }

  .worker-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: auto;
    padding-top: 2px;
  }

  .sm-btn {
    height: 27px;
    padding: 0 9px;
    font-size: 11.5px;
  }

  .disallowed-line {
    margin: 12px 0 0;
    font-size: 12px;
    color: var(--muted);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .audit-tools {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .toggle-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .toggle-check input {
    accent-color: var(--brand-green);
    margin: 0;
  }
  .toggle-n {
    font-size: 11px;
    color: var(--faint);
  }

  .audit-table-wrap {
    overflow-x: auto;
  }

  .audit-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .audit-table th,
  .audit-table td {
    text-align: left;
    padding: 8px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }

  .audit-table th {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .audit-table tr.is-reverted {
    opacity: 0.5;
  }

  .time-cell {
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }

  .actor-chip {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-chip);
    font-size: 11px;
    font-weight: 700;
    border: 1px solid var(--line);
  }
  .actor-chip.is-agent {
    background: var(--working-soft);
    border-color: color-mix(in srgb, var(--status-working) 42%, transparent);
    color: var(--status-working);
  }
  .actor-chip.is-user {
    background: var(--brand-soft);
    border-color: color-mix(in srgb, var(--brand-green) 42%, transparent);
    color: var(--brand-green);
  }

  .summary-cell {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
  }

  .action-tag {
    font-size: 11px;
    font-weight: 650;
    padding: 1px 6px;
    border-radius: var(--radius-chip);
    background: var(--surface-recessed);
    border: 1px solid var(--line);
    color: var(--muted);
  }

  .right-col {
    text-align: right !important;
    white-space: nowrap;
  }

  .reverted-label {
    font-size: 11.5px;
    color: var(--faint);
  }

  .custom-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
  }

  .custom-body {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .custom-body label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .custom-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .custom-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .trial-ok {
    margin: 0;
    font-size: 12.5px;
    color: var(--brand-green);
  }

  @media (max-width: 780px) {
    .policy-grid, .custom-grid { grid-template-columns: 1fr; }
    .cli-preview { display: none; }
    .settings { padding: 14px 12px 44px; }
  }
</style>
