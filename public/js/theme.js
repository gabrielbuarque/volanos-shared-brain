// ---- Theme (light / dark / auto) ----
const _prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
function setTheme(mode) {
  localStorage.setItem('sb_theme', mode)
  applyTheme()
}
function applyTheme() {
  // A marca Volanos não tem tema escuro: o app é sempre claro.
  const mode = 'light'
  const dark = false
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  const tc = document.querySelector('meta[name="theme-color"]')
  if (tc) tc.setAttribute('content', dark ? '#161616' : '#ffffff')
  document.querySelectorAll('#theme-toggle [data-theme-val]').forEach((b) => b.classList.toggle('active', b.dataset.themeVal === mode))
  if (graphState && graphState.api) graphState.api.redraw() // repaint the graph in the new theme's ink
}
_prefersDark.addEventListener('change', applyTheme)
