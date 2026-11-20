import { readFileSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked, Renderer } from 'marked'

const root = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? join(root, 'dist'))
const read = file => readFileSync(file, 'utf8')
const esc = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const version = JSON.parse(read(join(root, '../package.json'))).version
const canonical = (process.env.BROCO_SITE_URL || 'https://broco.yanauto.me').replace(/\/+$/, '')
const groups = [
  [['Getting started', '入门'], [['installation', 'Installation', '安装'], ['quickstart', 'Your first ticket', '第一张工单'], ['workers', 'Workers and login', '工人选择与登录'], ['allowlist', 'Global & repo policy', '全局与项目策略']]],
  [['Workers & config', '工人与配置'], [['roster', 'Worker roster', '工人花名册'], ['settings', 'Settings & undo', '配置与撤回'], ['model-inputs', 'Capabilities and media', '能力与附件'], ['custom-cli', 'Custom CLI templates', '自定义 CLI 模板']]],
  [['Working with tickets', '处理工单'], [['steering', 'Steering', '运行中插话'], ['review-worktree', 'Worktrees and review', '独立工作区与审查'], ['board', 'The board', '看板']]],
  [['Reference', '查阅'], [['commands', 'Command reference', '命令参考'], ['upgrade', 'Upgrading', '升级与迁移'], ['faq', 'FAQ', '常见问题']]]
]
const topics = groups.flatMap(([, items]) => items)
const ids = topics.map(([id]) => id)
const route = (lang, id) => (lang === 'zh' ? '/zh' : '') + (id === 'changelog' ? '/changelog/' : '/docs/' + (id === 'installation' ? '' : id + '/'))
const toPrefix = currentRoute => '../'.repeat(currentRoute.split('/').filter(Boolean).length)
const rel = (fromRoute, targetPath) => toPrefix(fromRoute) + targetPath.replace(/^\/+/, '')
const glossary = ['English', '简体中文']
const themeScript = `<script>(function(){try{var t=localStorage.getItem('broco-theme');document.documentElement.dataset.theme=t==='dark'?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();</script>`
const sunSvg = `<svg class="theme-icon-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/></svg>`
const moonSvg = `<svg class="theme-icon-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 10.2A5.5 5.5 0 0 1 5.8 2.8a5.5 5.5 0 1 0 7.4 7.4Z"/></svg>`

const changes = read(join(root, '../CHANGELOG.md')).trim().split(/^## /m).slice(1).map(block => {
  const [v, ...lines] = block.split('\n')
  const langs = lines.join('\n').trim().split(/^### (English|简体中文)\s*$/m)
  if (!/^\d+\.\d+\.\d+$/.test(v) || langs.length !== 5 || langs[1] !== glossary[0] || langs[3] !== glossary[1] || !langs[2].trim() || !langs[4].trim()) throw Error('Expected version and both translations in CHANGELOG.md: ' + v)
  return { v, parts: [langs[2], langs[4]] }
})
if (changes[0]?.v !== version || new Set(changes.map(c => c.v)).size !== changes.length) throw Error('Missing current or duplicate changelog version')

function slugify(text, usedIds) {
  const plain = text.replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '').trim()
  const base = plain.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section'
  let slug = base
  let n = 2
  while (usedIds.has(slug)) {
    slug = `${base}-${n}`
    n += 1
  }
  usedIds.add(slug)
  return slug
}

function renderMarkdown(source, file, fromRoute, lang, usedIds, headings) {
  const zh = lang === 'zh'
  const copyLabel = zh ? '复制' : 'Copy'
  const calloutTitles = zh
    ? { note: '说明', tip: '提示', warning: '注意' }
    : { note: 'NOTE', tip: 'TIP', warning: 'WARNING' }
  const md = new Marked({
    renderer: {
      link(token) {
        if (!token.href.endsWith('.md') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(token.href)) return false
        const path = relative(root, resolve(dirname(file), token.href)).split(sep)
        const id = path.at(-1).slice(0, -3)
        if (path.length !== 2 || !['zh', 'en'].includes(path[0]) || !ids.includes(id)) throw Error('Unknown guide link: ' + token.href)
        return `<a href="${rel(fromRoute, route(path[0], id))}">${this.parser.parseInline(token.tokens)}</a>`
      },
      heading(token) {
        const inner = this.parser.parseInline(token.tokens)
        const depth = token.depth
        if (usedIds && (depth === 2 || depth === 3)) {
          const slug = slugify(token.text, usedIds)
          const plain = inner.replace(/<[^>]+>/g, '').trim()
          if (headings) headings.push({ depth, id: slug, text: plain })
          return `<h${depth} id="${esc(slug)}">${inner}<a class="heading-anchor" href="#${encodeURIComponent(slug)}" aria-label="${esc(zh ? '本节链接' : 'Link to section')}">#</a></h${depth}>\n`
        }
        return `<h${depth}>${inner}</h${depth}>\n`
      },
      code(token) {
        const langTag = (token.lang || 'text').trim().split(/\s+/)[0] || 'text'
        return `<div class="code-block"><div class="code-bar"><span class="code-lang">${esc(langTag)}</span><button class="code-copy" type="button" data-copy-code>${copyLabel}</button></div><pre><code>${esc(token.text)}</code></pre></div>\n`
      },
      table(token) {
        return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`
      },
      blockquote(token) {
        const inner = this.parser.parse(token.tokens)
        const match = inner.match(/^\s*<p>\[!(NOTE|TIP|WARNING)\](?:\s*<br\s*\/?>|\s+|$)([\s\S]*)/i)
        if (!match) return `<blockquote>\n${inner}</blockquote>\n`
        const kind = match[1].toLowerCase()
        let rest = match[2]
        if (/^\s*<\/p>/i.test(rest)) {
          rest = rest.replace(/^\s*<\/p>\s*/i, '')
        } else {
          rest = `<p>${rest}`
        }
        return `<aside class="callout callout-${kind}" role="note"><p class="callout-label">${calloutTitles[kind]}</p>${rest}</aside>\n`
      }
    }
  })
  return md.parse(source)
}

function page(lang, id, title, lead, toc, article, headings = [], pager = '') {
  const zh = lang === 'zh'
  const t = (en, cn) => zh ? cn : en
  const log = id === 'changelog'
  const currentRoute = route(lang, id)
  const langTag = t('en', 'zh-CN')
  const other = t('zh', 'en')
  const nav = (dest, label, current) => `<a href="${rel(currentRoute, route(lang, dest))}"${current ? ' aria-current="page"' : ''}>${label}</a>`
  const sideTitle = log ? t('Release index', '版本目录') : t('Documentation', '使用文档')
  const description = esc(lead.replace(/<[^>]+>/g, '').trim())
  const ogImage = canonical + '/assets/broco-social-preview-1280x640.png'
  const hasOtp = headings.length > 0
  const otpHtml = hasOtp
    ? `<aside class="on-this-page" aria-label="${t('On this page', '本页目录')}"><p class="otp-title">${t('On this page', '本页目录')}</p><ul class="otp-list">${headings.map(h => `<li${h.depth === 3 ? ' class="is-sub"' : ''}><a href="#${encodeURIComponent(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul></aside>`
    : ''
  const html = `<!doctype html>
<html lang="${langTag}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
${themeScript}
<title>${esc(title)} · broco</title><meta name="description" content="${description}">
<link rel="canonical" href="${canonical + currentRoute}"><link rel="alternate" hreflang="en" href="${canonical + route('en', id)}"><link rel="alternate" hreflang="zh-CN" href="${canonical + route('zh', id)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="broco"><meta property="og:url" content="${canonical + currentRoute}"><meta property="og:title" content="${esc(title)} · broco"><meta property="og:description" content="${description}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="640"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${rel(currentRoute, 'favicon.ico')}" sizes="any"><link rel="icon" href="${rel(currentRoute, 'assets/broco-favicon-32.png')}" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="${rel(currentRoute, 'assets/broco-favicon-192.png')}">
<link rel="stylesheet" href="${rel(currentRoute, 'guide-assets/base.css')}"><link rel="stylesheet" href="${rel(currentRoute, 'guide-assets/guide.css')}">
<script type="module" src="${rel(currentRoute, 'guide-assets/guide.js')}"></script></head>
<body><a class="skip" href="#content">${t('Skip to content', '跳到正文')}</a>
<header class="mast"><div class="wrap nav">
  <div class="brand-group"><a class="brand" href="${rel(currentRoute, '?lang=' + lang)}"><img class="mascot-px" src="${rel(currentRoute, 'assets/broco-foreman-256.png')}" alt="" width="24" height="24">broco</a><a class="ver-pill" href="${rel(currentRoute, route(lang, 'changelog'))}">v${version}</a></div>
  <nav class="top-nav" aria-label="${t('Main', '主导航')}">${nav('installation', t('Docs', '文档'), !log)}${nav('changelog', t('Changelog', '更新日志'), log)}<a href="https://github.com/yanauto/broco">GitHub ↗</a><span class="separator"></span><div class="nav-controls"><button class="nav-btn" id="theme-toggle" type="button" aria-label="${t('Switch theme', '切换主题')}">${sunSvg}${moonSvg}</button><a class="nav-btn" lang="${t('zh-CN', 'en')}" hreflang="${t('zh-CN', 'en')}" href="${rel(currentRoute, route(other, id))}">${t('中文', 'EN')}</a></div></nav>
</div></header>
<div class="wrap layout${hasOtp ? '' : ' no-otp'}"><aside class="side" aria-label="${sideTitle}"><p class="side-title">${sideTitle}</p>${toc}</aside><main id="content">
<details class="mobile-toc"><summary>${sideTitle}</summary>${toc}</details>
<p class="kicker"><span>broco / v${version}</span> / ${log ? t('Release notes', '版本记录') : t('Field manual', '工地手册') + ' · ' + String(ids.indexOf(id) + 1).padStart(2, '0') + ' / ' + ids.length}</p>
<h1>${esc(title)}</h1><div class="lead">${lead}</div>${article}${pager}</main>${otpHtml}</div>
<footer class="wrap guide-foot"><span>broco / v${version} · Apache-2.0</span><a href="https://github.com/yanauto/broco">GitHub ↗</a></footer></body></html>
`
  const dir = join(out, currentRoute)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}

for (const [index, lang] of ['en', 'zh'].entries()) {
  const files = readdirSync(join(root, lang)).sort()
  if (files.join() !== ids.map(id => id + '.md').sort().join()) throw Error('Topic list and ' + lang + ' sources differ')
  for (const [i, id] of ids.entries()) {
    const file = join(root, lang, id + '.md')
    const currentRoute = route(lang, id)
    const match = read(file).trim().match(/^# ([^\n]+)\n\n([\s\S]*?)(?:\n\n|$)([\s\S]*)$/)
    if (!match) throw Error('Expected a title and introduction in ' + file)
    const [, title, intro, rest] = match
    const usedIds = new Set(['content', 'theme-toggle'])
    const headings = []
    const leadHtml = renderMarkdown(intro, file, currentRoute, lang, null, null)
    const bodyHtml = renderMarkdown(rest, file, currentRoute, lang, usedIds, headings)
    const toc = groups.map(([names, items]) => `<p class="section-label">${names[index]}</p><div class="toc">` + items.map(([slug, ...labels]) => `<a href="${rel(currentRoute, route(lang, slug))}"${id === slug ? ' aria-current="page"' : ''}>${labels[index]}</a>`).join('') + '</div>').join('')
    const pager = [[i - 1, 'prev', index ? '上一页' : 'Previous'], [i + 1, 'next', index ? '下一页' : 'Next']].filter(([n]) => topics[n]).map(([n, linkRel, label]) => `<a rel="${linkRel}" href="${rel(currentRoute, route(lang, ids[n]))}"><small>${label}</small>${topics[n][index + 1]}</a>`).join('')
    page(lang, id, title, leadHtml, toc, `<article class="prose">${bodyHtml}</article>`, headings, `<nav class="pager" aria-label="${index ? '相关章节' : 'Guide pages'}">${pager}</nav>`)
  }
  const logRoute = route(lang, 'changelog')
  const usedIds = new Set(['content', 'theme-toggle', ...changes.map(({ v }) => 'v' + v)])
  const toc = '<div class="toc">' + changes.map(({ v }) => `<a href="#v${v}">v${v}</a>`).join('') + '</div>'
  const logHeadings = changes.map(({ v }) => ({ depth: 2, id: 'v' + v, text: 'v' + v }))
  const notes = changes.map(({ v, parts }) => `<section class="prose release" id="v${v}"><span class="release-id">${index ? '版本' : 'Version'}</span><h2>${v}</h2>${renderMarkdown(parts[index].replace(/^#### /gm, '### '), join(root, '../CHANGELOG.md'), logRoute, lang, usedIds, null)}</section>`).join('')
  page(lang, 'changelog', index ? '更新日志' : 'Changelog', index ? '按版本查看工人、工单与升级方式的变化。' : 'What changed for workers, hosts, and tickets, and how to upgrade.', toc, notes, logHeadings)
}

const guideAssetsDir = join(out, 'guide-assets')
mkdirSync(guideAssetsDir, { recursive: true })
for (const file of ['base.css', 'guide.css', 'guide.js']) {
  copyFileSync(join(root, 'assets', file), join(guideAssetsDir, file))
}
copyFileSync(join(root, 'assets', 'favicon.ico'), join(out, 'favicon.ico'))
const assetDir = join(out, 'assets')
const fontDir = join(assetDir, 'fonts')
mkdirSync(fontDir, { recursive: true })
for (const file of ['broco-foreman-256.png', 'broco-favicon-32.png', 'broco-favicon-64.png', 'broco-favicon-192.png', 'broco-social-preview-1280x640.png']) {
  copyFileSync(join(root, 'assets', file), join(assetDir, file))
}
for (const file of ['instrument-sans-latin.woff2', 'jetbrains-mono-latin.woff2']) {
  copyFileSync(join(root, 'assets/fonts', file), join(fontDir, file))
}
