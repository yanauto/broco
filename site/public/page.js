const dispatchScenes = {
  quota: {
    foreman: {
      en: 'codex 89% -> hand off to agy',
      zh: 'codex 89% -> 转交 agy 处理'
    },
    cmd: '$ broco say auth-fix "Fix verifyToken expiry" --worker agy --worktree --bg',
    lines: {
      en: [
        ['', '▸', 'from: claude -> global allowlist (~/.broco/)'],
        ['is-warn', '▸', 'roster: codex 5h 89% (avoid) → selected agy (5h 4% plentiful)'],
        ['is-good', '✓', 'ticket #43 running in worktree broco/auth-fix · via stdin']
      ],
      zh: [
        ['', '▸', '来源：claude -> 全局白名单（~/.broco/）'],
        ['is-warn', '▸', '查 roster：codex 5h 89%（avoid）→ 选用 agy（5h 4% plentiful）'],
        ['is-good', '✓', '任务 #43 已在独立 worktree broco/auth-fix 运行 · stdin 传题']
      ]
    }
  },
  review: {
    foreman: {
      en: 'diff ready -> blind review by claude',
      zh: '补丁就绪 -> 自动请 claude 盲审'
    },
    cmd: '$ broco review auth-fix --bg --json',
    lines: {
      en: [
        ['', '▸', 'author: agy (gemini) → auto-pick other vendor: claude'],
        ['is-warn', '▸', 'scope: git diff main..broco/auth-fix (+44 -9 · 2 files)'],
        ['is-good', '✓', 'review #44 PASS · clean diff · ready for broco clean']
      ],
      zh: [
        ['', '▸', '原作者 agy → 省略 --by 自动换另一家模型 claude 盲审'],
        ['is-warn', '▸', '审查范围：git diff main..broco/auth-fix（+44 -9 · 2 个文件）'],
        ['is-good', '✓', '审查 #44 PASS · 改动干净 · 可直接 broco clean']
      ]
    }
  },
  map: {
    foreman: {
      en: '16 shards -> pi:deepseek (concurrency 4)',
      zh: '16 个分片 -> pi:deepseek 4 并发'
    },
    cmd: '$ broco map audit-api src/routes/*.ts --brief-file check.md --worker pi:deepseek --bg',
    lines: {
      en: [
        ['', '▸', 'batch audit-api · 16 shards · worker: pi:deepseek · concurrency 4'],
        ['is-warn', '▸', 'progress: 12 / 16 done · 4 running · 41s elapsed'],
        ['is-good', '✓', '12/12 passed so far · broco wait audit-api --json collects all 16']
      ],
      zh: [
        ['', '▸', '批次 audit-api · 16 个分片 · 执行者 pi:deepseek · 并发上限 4'],
        ['is-warn', '▸', '进度：12 / 16 完成 · 4 个在跑 · 已耗时 41s'],
        ['is-good', '✓', '已完成分片全部通过 · 执行 broco wait audit-api --json 回收全部结果']
      ]
    }
  }
}

const hoodMeta = {
  isolation: {
    path: '~/.broco/ · local official CLI processes',
    badge: { en: 'DISPATCH', zh: '进程调度' },
    doc: 'allowlist',
    docLabel: { en: 'Policy & isolation guide', zh: '查看策略与隔离文档' },
    caption: {
      en: 'Every worker runs as a local child process under your existing CLI login, with task state kept outside your repo.',
      zh: '每个协作者都以本机子进程复用你现有的 CLI 登录，运行状态统一留在仓库之外。'
    }
  },
  review: {
    path: 'broco diff auth-fix --stat && broco review auth-fix',
    badge: { en: 'BLIND REVIEW', zh: '跨模型盲审' },
    doc: 'review-worktree',
    docLabel: { en: 'Worktrees & review guide', zh: '查看 Worktree 与盲审文档' },
    caption: {
      en: 'Inspect changes with broco diff, run broco review for an independent audit, then clean up with broco clean.',
      zh: '用 broco diff 核对改动，跑 broco review 请另一家模型独立审读，合并后用 broco clean 收尾。'
    }
  },
  board: {
    path: 'broco ui · http://127.0.0.1:4173',
    badge: { en: 'LOCAL BOARD', zh: '本地看板' },
    doc: 'board',
    docLabel: { en: 'Board guide', zh: '查看本地看板文档' },
    caption: {
      en: 'Launch broco ui whenever you want a local browser view of parallel runs, quotas, errors, and linked reviews.',
      zh: '需要总览时随时运行 broco ui，在本地浏览器里查看并行任务、额度、报错与审查关联。'
    }
  }
}

const setupModes = {
  l0: {
    code: 'npm install -g broco\nbroco setup',
    en: 'Writes to ~/.broco/, ~/.agents/skills/broco/, and detected local harness skill folders (Claude Code, Codex, Antigravity, Cursor, OpenCode, Pi). Your repo stays untouched.',
    zh: '仅写入 ~/.broco/、~/.agents/skills/broco/ 以及本机已检测到的宿主 skills 目录（Claude Code、Codex、Antigravity、Cursor、OpenCode、Pi），项目仓库保持原样。'
  },
  l1: {
    code: 'npm install -g broco\nbroco setup\nbroco init --allow claude,codex,agy,pi:deepseek --default-worker agy --concurrency 4',
    en: 'Optional per-repo mode: adds .broco/ and a marked AGENTS.md section when a repo needs its own allowlist or concurrency cap.',
    zh: '可选项目级模式：写入 .broco/ 并维护 AGENTS.md 标记段，适合需要单独锁定可用 harness 与并发上限的仓库。'
  },
  migrate: {
    code: 'npm install -g broco\nbroco shutdown\nbroco setup --migrate-cc-bro',
    en: 'Stops running cc-bro background workers cleanly and moves ~/.cc-bro/ projects and ticket history into ~/.broco/.',
    zh: '平滑停止旧 cc-bro 后台进程，并将 ~/.cc-bro/ 下的项目配置与历史工单迁入 ~/.broco/。'
  }
}

const byId = id => document.getElementById(id)
const themeBtn = byId('theme-toggle')
const languageBtn = byId('language')
const sceneTabs = Array.from(document.querySelectorAll('[data-scene]'))
const hoodTabs = Array.from(document.querySelectorAll('[data-hood]'))
const modeTabs = Array.from(document.querySelectorAll('[data-mode]'))
const translations = Array.from(document.querySelectorAll('[data-zh]'), el => [el, el.textContent])
const ariaLabels = Array.from(document.querySelectorAll('[data-zh-aria]'), el => [el, el.getAttribute('aria-label')])

let language = 'en'
let activeScene = 'quota'
let activeHood = 'isolation'
let activeMode = 'l0'

try { if (localStorage.getItem('site-language') === 'zh') language = 'zh' } catch {}
const requestedLang = new URLSearchParams(location.search).get('lang')
if (requestedLang === 'zh' || requestedLang === 'en') {
  language = requestedLang
  try { localStorage.setItem('site-language', language) } catch {}
}

function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark'
  themeBtn.setAttribute('aria-pressed', String(dark))
  themeBtn.setAttribute(
    'aria-label',
    dark
      ? (language === 'zh' ? '切换到日班浅色主题' : 'Switch to Day Shift light theme')
      : (language === 'zh' ? '切换到夜班深色主题' : 'Switch to Night Shift dark theme')
  )
}

function renderScene() {
  const entry = dispatchScenes[activeScene]
  byId('foreman-note').textContent = entry.foreman[language]
  byId('scene-cmd').textContent = entry.cmd
  const container = byId('scene-lines')
  container.replaceChildren()
  for (const [cls, mark, text] of entry.lines[language]) {
    const row = document.createElement('div')
    row.className = 'stage-line'
    const sym = document.createElement('span')
    sym.className = cls ? 'sl-mark ' + cls : 'sl-mark'
    sym.textContent = mark
    const body = document.createElement('span')
    body.textContent = text
    row.append(sym, body)
    container.append(row)
  }
  const panel = byId('panel-dispatch')
  for (const tab of sceneTabs) {
    const selected = tab.dataset.scene === activeScene
    tab.setAttribute('aria-selected', String(selected))
    if (selected) panel.setAttribute('aria-labelledby', tab.id)
  }
}

function renderHood() {
  const meta = hoodMeta[activeHood]
  byId('hood-path').textContent = meta.path
  byId('hood-badge').textContent = meta.badge[language]
  byId('hood-caption').textContent = meta.caption[language]
  const docLink = byId('hood-doc-link')
  docLink.href = (language === 'zh' ? 'zh/' : '') + 'docs/' + meta.doc + '/'
  docLink.firstElementChild.textContent = meta.docLabel[language]
  for (const tab of hoodTabs) {
    const selected = tab.dataset.hood === activeHood
    tab.setAttribute('aria-selected', String(selected))
    const panel = byId('hood-panel-' + tab.dataset.hood)
    if (panel) panel.hidden = !selected
  }
}

function renderMode() {
  const entry = setupModes[activeMode]
  byId('setup-commands').textContent = entry.code
  byId('setup-note').textContent = entry[language]
  const panel = byId('setup-terminal')
  for (const tab of modeTabs) {
    const selected = tab.dataset.mode === activeMode
    tab.setAttribute('aria-selected', String(selected))
    if (selected) panel.setAttribute('aria-labelledby', tab.id)
  }
}

function renderLanguage() {
  const zh = language === 'zh'
  document.documentElement.lang = zh ? 'zh-CN' : 'en'
  document.title = zh ? 'broco · 不同 harness 里的 AI，一起干活。' : 'broco · Let your harnesses work together.'
  for (const [el, en] of translations) el.textContent = zh ? el.dataset.zh : en
  for (const [el, en] of ariaLabels) el.setAttribute('aria-label', zh ? el.dataset.zhAria : en)
  languageBtn.lang = zh ? 'en' : 'zh-CN'
  languageBtn.textContent = zh ? 'EN' : '中文'
  languageBtn.setAttribute('aria-label', zh ? 'Switch to English' : '切换到中文')
  for (const link of document.querySelectorAll('[data-route]')) {
    link.href = (zh ? 'zh/' : '') + link.dataset.route + '/'
  }
  byId('notice').textContent = ''
  syncThemeButton()
  renderScene()
  renderHood()
  renderMode()
}

async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const range = document.createRange()
    range.selectNodeContents(fallbackEl)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const ok = document.execCommand('copy')
    if (ok) selection.removeAllRanges()
    return ok
  }
}

function wireCopyButton(buttonId, sourceId, resetEn, resetZh) {
  let timer
  const btn = byId(buttonId)
  btn.addEventListener('click', async () => {
    const src = byId(sourceId)
    const ok = await copyText(src.textContent, src)
    const zh = language === 'zh'
    btn.toggleAttribute('data-copied', ok)
    const msg = ok ? (zh ? '已复制' : 'Copied') : (zh ? '请手动复制' : 'Select text')
    btn.textContent = msg
    byId('notice').textContent = msg
    clearTimeout(timer)
    timer = setTimeout(() => {
      btn.removeAttribute('data-copied')
      btn.textContent = language === 'zh' ? resetZh : resetEn
    }, 2000)
  })
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try { localStorage.setItem('broco-theme', next) } catch {}
  syncThemeButton()
})

languageBtn.addEventListener('click', () => {
  language = language === 'en' ? 'zh' : 'en'
  try { localStorage.setItem('site-language', language) } catch {}
  if (requestedLang) {
    const url = new URL(location.href)
    url.searchParams.set('lang', language)
    history.replaceState(null, '', url)
  }
  renderLanguage()
})

for (const tab of sceneTabs) {
  tab.addEventListener('click', () => {
    activeScene = tab.dataset.scene
    renderScene()
  })
}

for (const tab of hoodTabs) {
  tab.addEventListener('click', () => {
    activeHood = tab.dataset.hood
    renderHood()
  })
}

for (const tab of modeTabs) {
  tab.addEventListener('click', () => {
    activeMode = tab.dataset.mode
    renderMode()
    const copyBtn = byId('setup-copy')
    copyBtn.removeAttribute('data-copied')
    copyBtn.textContent = language === 'zh' ? '复制命令' : 'Copy'
  })
}

wireCopyButton('hero-copy', 'hero-command', 'Copy', '复制')
wireCopyButton('setup-copy', 'setup-commands', 'Copy', '复制命令')
renderLanguage()
