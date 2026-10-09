/**
 * Auditoria de marca no navegador (roda dentro da página, via scripts/capture-screens.mjs --audit).
 * Confere o que só o CSS computado mostra: cores só da paleta, nenhuma sombra estática, só Montserrat
 * e Merriweather (esta só na virada e em títulos do Canon), caixa alta só onde a marca manda,
 * rolagem horizontal da página e alvos sem nome acessível.
 * Devolve uma lista de achados; vazia = tela dentro do portão.
 */
;(() => {
  const root = getComputedStyle(document.documentElement)
  const tokens = ['--volanos-blue', '--light-blue', '--neutral-gray', '--lead-grey', '--off-white', '--white', '--volanos-blue-deep', '--lead-grey-raised', '--grey-eyebrow', '--grey-caption', '--grey-eyebrow-dark', '--text-secondary']
  const probe = document.createElement('span')
  document.body.appendChild(probe)
  const norm = (c) => {
    probe.style.color = ''
    probe.style.color = c
    return getComputedStyle(probe).color
  }
  const palette = new Set(tokens.map((t) => norm(root.getPropertyValue(t).trim())))
  // Linhas e véus são navy ou branco com transparência, definidos em tokens: aceitos por família.
  const navy = norm(root.getPropertyValue('--volanos-blue').trim())
  const isNavyAlpha = (c) => /^rgba\(15, 31, 73, /.test(c)
  const isWhiteAlpha = (c) => /^rgba\(255, 255, 255, /.test(c)
  probe.remove()

  const okColor = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent' || palette.has(c) || isNavyAlpha(c) || isWhiteAlpha(c)
  const findings = []
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`
  const UPPER_OK = /conflict__vs|v-eyebrow|v-btn|v-tabs__tab|v-field__label|topbar__link|v-toast__title|sg-|v-badge|matrix__head|matrix__more/
  const seen = new Set()
  const add = (kind, el, detail) => {
    const k = `${kind}|${label(el)}|${detail}`
    if (seen.has(k)) return
    seen.add(k)
    findings.push(`${kind}: ${label(el)} ${detail}`)
  }

  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName !== 'svg') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || el.getClientRects().length === 0) continue
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor']) {
      if (prop.startsWith('border') && cs[prop.replace('Color', 'Style')] === 'none') continue
      if (prop === 'outlineColor' && cs.outlineStyle === 'none') continue
      if (!okColor(cs[prop])) add('cor fora da paleta', el, `${prop}=${cs[prop]}`)
    }
    if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) add('imagem de fundo inesperada', el, cs.backgroundImage.slice(0, 40))
    if (/gradient/.test(cs.backgroundImage) && !el.closest('#login')) add('gradiente fora do login', el, '')
    if (cs.boxShadow !== 'none' && !el.closest('.v-dialog, .v-toast, .is-hover')) add('sombra estática', el, cs.boxShadow.slice(0, 40))
    const font = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim()
    if (!/^(Montserrat|Merriweather)$/.test(font)) add('fonte fora da marca', el, font)
    if (font === 'Merriweather' && !(el.matches('em') && el.closest('.v-lede, .v-statement')) && !el.closest('.v-title-canon')) add('Merriweather fora da virada e do Canon', el, '')
    if (cs.textTransform === 'uppercase' && !UPPER_OK.test(el.className && typeof el.className === 'string' ? el.className : '') && !el.closest('.v-btn, .v-tabs, .topbar__nav, .sg-toc, .matrix__more')) add('caixa alta fora dos kickers', el, '')
    if (el.children.length === 0 && el.textContent && /!|\p{Extended_Pictographic}/u.test(el.textContent) && !el.closest('code, .source__body, .doc__body')) add('exclamação ou emoji', el, el.textContent.trim().slice(0, 30))
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) add('rolagem horizontal da página', document.body, `${document.documentElement.scrollWidth}px > ${window.innerWidth}px`)
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
    if (el.getClientRects().length === 0) continue
    const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length) || el.getAttribute('title') || el.getAttribute('placeholder')
    if (!name) add('controle sem nome acessível', el, '')
    const r = el.getBoundingClientRect()
    if ((r.width < 24 || r.height < 24) && !el.classList.contains('v-tag__remove') && !el.closest('label') && el.type !== 'checkbox') add('alvo pequeno', el, `${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  return findings
})()
