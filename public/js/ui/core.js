/**
 * Volanos UI: núcleo. Button, IconButton, Card, LevelPill, Tag, Tabs.
 * Seguem components/core/*.prompt.md e *.d.ts do Volanos Design System.
 */
;(function (g) {
  const VUI = (g.VUI = g.VUI || {})
  const { h, cx, Icon } = VUI

  /**
   * Pílula de ação em caixa alta. Um primário por tela.
   * `variant`: primary | secondary | ghost. `href` renderiza <a>. `loading` mostra o texto de espera.
   */
  function Button({ variant = 'primary', size = 'md', icon, iconAfter, href, disabled, loading, onClick, type, class: klass, ...rest } = {}, ...children) {
    const isLink = !!href
    const glyphSize = size === 'lg' ? 18 : 16
    const props = {
      class: cx('v-btn', `v-btn--${variant}`, `v-btn--${size}`, loading && 'v-btn--loading', klass),
      onClick: disabled || loading ? undefined : onClick,
      ...rest,
    }
    if (isLink) Object.assign(props, { href, ...(disabled ? { 'aria-disabled': 'true', tabindex: '-1' } : {}) })
    else Object.assign(props, { type: type || 'button', disabled: !!disabled, ...(loading ? { 'aria-busy': 'true' } : {}) })
    return h(isLink ? 'a' : 'button', props, icon ? Icon({ name: icon, size: glyphSize }) : null, ...children, iconAfter ? Icon({ name: iconAfter, size: glyphSize }) : null)
  }

  /** Botão só de ícone. `label` é obrigatório: vira aria-label e title. */
  function IconButton({ icon, label, variant = 'outline', size = 'md', onClick, disabled, class: klass, ...rest } = {}) {
    return h(
      'button',
      { type: 'button', 'aria-label': label, title: label, disabled: !!disabled, onClick, class: cx('v-iconbtn', `v-iconbtn--${size}`, variant === 'solid' && 'v-iconbtn--solid', klass), ...rest },
      Icon({ name: icon, size: size === 'lg' ? 22 : size === 'sm' ? 14 : 18 }),
    )
  }

  /**
   * Container de 16px de raio. Sem sombra em repouso; `interactive` adiciona a elevação só no hover.
   * `variant`: surface | outline | navy | plain | selected.
   */
  function Card({ variant = 'surface', pad = true, interactive, as = 'div', class: klass, ...rest } = {}, ...children) {
    const el = h(as, { class: cx('v-card', variant !== 'surface' && `v-card--${variant}`, pad && 'v-card--pad', interactive && 'v-card--interactive', klass), ...rest }, ...children)
    return el
  }

  /** Quando o nível é restrito, médio ou amplo. A forma muda; o número sempre aparece. */
  function levelShape(level) {
    return level <= 3 ? 'high' : level <= 8 ? 'mid' : 'low'
  }

  /**
   * Pílula do nível P (P0 mais restrito, P12 mais amplo). Sem cor de status: a forma agrupa
   * (preenchido, contorno, cinza) e o texto "P7" diz o nível. `text` vira o tooltip nativo.
   */
  function LevelPill({ level, text, size = 'md', class: klass } = {}) {
    const n = Number(level)
    if (!Number.isInteger(n) || n < 0 || n > 12) return h('span', { class: cx('v-level', 'v-level--low', klass) }, 'P?')
    return h('span', { class: cx('v-level', `v-level--${levelShape(n)}`, size === 'sm' && 'v-level--sm', klass), title: text || undefined, 'data-level': String(n) }, `P${n}`)
  }

  /** Pílula de 27px para rótulo, filtro e seleção removível. Sentence case. */
  function Tag({ variant = 'solid', selected, onRemove, removeLabel = 'Remover', onClick, class: klass, ...rest } = {}, ...children) {
    const v = selected ? 'solid' : variant
    const el = h(
      onClick ? 'button' : 'span',
      { type: onClick ? 'button' : undefined, onClick, class: cx('v-tag', v !== 'solid' && `v-tag--${v}`, onClick && 'v-tag--selectable', klass), 'aria-pressed': onClick ? String(!!selected) : undefined, ...rest },
      ...children,
    )
    if (onRemove) {
      el.appendChild(h('button', { type: 'button', class: 'v-tag__remove', 'aria-label': removeLabel, onClick: (e) => { e.stopPropagation(); onRemove(e) } }, Icon({ name: 'x', size: 12 })))
    }
    return el
  }

  /**
   * Abas com teclado (setas, Home, End). Devolve o elemento; `.select(id)` troca por código.
   * `items`: [{ id, label }]. `variant`: underline | pill.
   */
  function Tabs({ items = [], value, onChange, variant = 'underline', label, class: klass } = {}) {
    let active = value != null ? value : items[0] && items[0].id
    const list = h('div', { role: 'tablist', 'aria-label': label, class: cx('v-tabs', variant === 'pill' && 'v-tabs--pill', klass) })
    const tabs = items.map((it) => h('button', { type: 'button', role: 'tab', id: it.domId, class: 'v-tabs__tab', 'data-tab': it.id, 'aria-controls': it.panelId }, it.label))
    tabs.forEach((tab) => list.appendChild(tab))

    function paint() {
      tabs.forEach((tab) => {
        const on = tab.dataset.tab === active
        tab.setAttribute('aria-selected', String(on))
        tab.setAttribute('tabindex', on ? '0' : '-1')
      })
    }
    function select(id, { focus = false, silent = false } = {}) {
      active = id
      paint()
      if (focus) tabs.find((t) => t.dataset.tab === id)?.focus()
      if (!silent && onChange) onChange(id)
    }
    tabs.forEach((tab) => tab.addEventListener('click', () => select(tab.dataset.tab)))
    list.addEventListener('keydown', (e) => {
      const i = tabs.findIndex((t) => t.dataset.tab === active)
      const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
      if (to === null) return
      e.preventDefault()
      select(tabs[(to + tabs.length) % tabs.length].dataset.tab, { focus: true })
    })
    list.select = select
    paint()
    return list
  }

  Object.assign(VUI, { Button, IconButton, Card, LevelPill, levelShape, Tag, Tabs })
})(typeof globalThis !== 'undefined' ? globalThis : window)
