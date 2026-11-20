const isZh = document.documentElement.lang.startsWith('zh')
const themeBtn = document.getElementById('theme-toggle')

function syncThemeLabel() {
  if (!themeBtn) return
  const dark = document.documentElement.dataset.theme === 'dark'
  themeBtn.setAttribute('aria-pressed', String(dark))
  themeBtn.setAttribute(
    'aria-label',
    dark
      ? (isZh ? '切换到日班浅色主题' : 'Switch to Day Shift light theme')
      : (isZh ? '切换到夜班深色主题' : 'Switch to Night Shift dark theme')
  )
}

if (themeBtn) {
  syncThemeLabel()
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('broco-theme', next) } catch {}
    syncThemeLabel()
  })
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

for (const btn of document.querySelectorAll('[data-copy-code]')) {
  let timer
  const defaultLabel = btn.textContent
  btn.addEventListener('click', async () => {
    const block = btn.closest('.code-block')
    const code = block && block.querySelector('pre code')
    if (!code) return
    const ok = await copyText(code.textContent, code)
    btn.toggleAttribute('data-copied', ok)
    btn.textContent = ok ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制失败' : 'Select text')
    clearTimeout(timer)
    timer = setTimeout(() => {
      btn.removeAttribute('data-copied')
      btn.textContent = defaultLabel
    }, 2000)
  })
}

const otpLinks = Array.from(document.querySelectorAll('.otp-list a'))
if (otpLinks.length > 0 && 'IntersectionObserver' in window) {
  const byId = new Map()
  const targets = []
  for (const link of otpLinks) {
    const id = decodeURIComponent(link.getAttribute('href').slice(1))
    const el = document.getElementById(id)
    if (el) {
      byId.set(id, link)
      targets.push(el)
    }
  }
  const setActive = id => {
    for (const link of otpLinks) link.classList.toggle('is-active', link === byId.get(id))
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        setActive(entry.target.id)
        break
      }
    }
  }, { rootMargin: '-76px 0px -70% 0px', threshold: 0 })
  for (const el of targets) observer.observe(el)
}
