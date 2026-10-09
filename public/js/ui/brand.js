/**
 * Volanos UI: primitivos de marca. Icon, Logo, Eyebrow, Statement, Rule.
 * Seguem components/brand/*.prompt.md e *.d.ts do Volanos Design System.
 */
;(function (g) {
  const VUI = (g.VUI = g.VUI || {})
  const { h, cx } = VUI

  /**
   * Glifo do subset Lucide embutido (js/ui/icons.js), em currentColor.
   * Decorativo por padrão (aria-hidden); passe `title` quando o ícone for o único rótulo.
   */
  function Icon({ name, size = 20, title, class: klass } = {}) {
    const body = VUI.ICONS && VUI.ICONS[name]
    if (!body) {
      if (typeof console !== 'undefined') console.warn(`Icon: glifo desconhecido "${name}"`)
      return h('span', { class: cx('v-icon', klass), style: { width: size + 'px', height: size + 'px' } })
    }
    const svg = h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    // Corpo fixo e confiável, vindo do pacote do DS: nunca de dados de usuário.
    svg.innerHTML = body
    return h('span', { class: cx('v-icon', klass), style: { width: size + 'px', height: size + 'px' }, ...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': 'true' }) }, svg)
  }

  const LOGO_FILES = {
    'wordmark-navy': 'volanos-wordmark-navy.svg',
    'wordmark-white': 'volanos-wordmark-white.svg',
    'symbol-navy': 'volanos-symbol-navy.svg',
    'symbol-white': 'volanos-symbol-white.svg',
    'symbol-outline-navy': 'volanos-symbol-outline-navy.svg',
    'symbol-outline-white': 'volanos-symbol-outline-white.svg',
  }

  /** Marca da Volanos. A versão principal (wordmark) nunca fica abaixo de 96px de largura. */
  function Logo({ variant = 'wordmark', tone = 'navy', outline = false, width } = {}) {
    const key = variant === 'symbol' ? `symbol${outline ? '-outline' : ''}-${tone}` : `wordmark-${tone}`
    let w = width || (variant === 'symbol' ? 40 : 160)
    if (variant === 'wordmark' && w < 96) w = 96
    return h('span', { class: 'v-logo', style: { width: w + 'px' } }, h('img', { src: `assets/logo/${LOGO_FILES[key] || LOGO_FILES['wordmark-navy']}`, alt: 'Volanos' }))
  }

  /** O kicker que abre quase toda página: caixa alta, +0,1em de tracking. */
  function Eyebrow({ as = 'div', class: klass, id } = {}, ...children) {
    return h(as, { class: cx('v-eyebrow', klass), id }, ...children)
  }

  /**
   * A construção assinatura: uma cláusula em Montserrat e a "virada" em Merriweather itálico,
   * depois de um travessão. É o único lugar do app com Merriweather fora dos títulos do Canon.
   * `size`: "lede" (34px) ou "statement" (36px). `support` é um parágrafo curto abaixo.
   */
  function Statement({ turn, support, size = 'lede', align = 'left', class: klass, as = 'p' } = {}, ...children) {
    const line = h(as, { class: size === 'statement' ? 'v-statement' : 'v-lede' }, ...children, turn ? [' — ', h('em', null, turn)] : null)
    return h('div', { class: cx('v-statement-wrap', klass), style: { textAlign: align } }, line, support ? h('p', { class: 'v-body', style: { margin: 'var(--space-4) 0 0' } }, support) : null)
  }

  /** O divisor de 2px navy, único peso de separador da marca. Use `hair` para tabelas e cartões. */
  function Rule({ width, tone = 'ink', hair = false, class: klass } = {}) {
    const hr = h('hr', { class: cx('v-rule', hair && 'v-rule--hair', klass) })
    if (width) hr.style.width = typeof width === 'number' ? width + 'px' : width
    if (tone === 'inverse') hr.style.borderTopColor = 'var(--line-on-dark)'
    return hr
  }

  Object.assign(VUI, { Icon, Logo, Eyebrow, Statement, Rule })
})(typeof globalThis !== 'undefined' ? globalThis : window)
