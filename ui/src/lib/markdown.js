function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(escaped) {
  const codes = []
  let out = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codes.push(`<code class="md-code">${code}</code>`) - 1
    return `\u0000C${idx}\u0000`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,!?:;]|$)/g, '$1<strong>$2</strong>')
  return out.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

function renderBlocks(chunk) {
  const lines = chunk.split('\n')
  const out = []
  let para = []
  let listType = null
  let listItems = []

  const flushPara = () => {
    if (!para.length) return
    out.push(`<p class="md-p">${para.map(l => renderInline(escapeHtml(l))).join('<br>')}</p>`)
    para = []
  }

  const flushList = () => {
    if (!listType || !listItems.length) return
    const tag = listType === 'ol' ? 'ol' : 'ul'
    out.push(`<${tag} class="md-list">${listItems.map(item => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`)
    listType = null
    listItems = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      flushList()
      continue
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushPara()
      flushList()
      out.push(`<div class="md-h md-h${heading[1].length}">${renderInline(escapeHtml(heading[2]))}</div>`)
      continue
    }
    const ul = /^[-*+]\s+(.+)$/.exec(trimmed)
    if (ul) {
      flushPara()
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(ul[1])
      continue
    }
    const ol = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (ol) {
      flushPara()
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(ol[1])
      continue
    }
    flushList()
    para.push(line)
  }

  flushPara()
  flushList()
  return out.join('')
}

export function renderMarkdown(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  const parts = []
  const fence = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g
  let last = 0
  let match
  while ((match = fence.exec(text))) {
    if (match.index > last) {
      parts.push(renderBlocks(text.slice(last, match.index)))
    }
    const lang = match[1] ? `<span class="md-lang">${escapeHtml(match[1])}</span>` : ''
    const body = escapeHtml(match[2].replace(/\n$/, ''))
    parts.push(`<div class="md-pre-wrap">${lang}<pre class="md-pre"><code>${body}</code></pre></div>`)
    last = fence.lastIndex
  }
  if (last < text.length) {
    parts.push(renderBlocks(text.slice(last)))
  }
  return parts.join('')
}
