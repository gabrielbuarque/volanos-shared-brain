/**
 * Volanos UI: retorno ao usuário. Dialog, Toast, Tooltip.
 * Seguem components/feedback/*.prompt.md. Diálogo e toast são os únicos com sombra (--shadow-float).
 */
;(function (g) {
  const VUI = (g.VUI = g.VUI || {})
  const { h, cx, uid, Icon, IconButton } = VUI

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

  /**
   * Monta o diálogo (sem anexar). Use VUI.openDialog para abrir de fato.
   * `onClose` ausente = diálogo que não se dispensa por fora.
   */
  function Dialog({ title, actions, onClose, closeLabel = 'Fechar', class: klass } = {}, ...children) {
    const titleId = uid('dialog-title')
    const dialog = h(
      'div',
      { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : undefined, class: cx('v-dialog', klass), tabindex: '-1', onClick: (e) => e.stopPropagation() },
      onClose ? h('span', { class: 'v-dialog__close' }, IconButton({ icon: 'x', label: closeLabel, size: 'sm', onClick: onClose })) : null,
      title ? h('h2', { class: 'v-dialog__title', id: titleId }, title) : null,
      h('div', { class: 'v-dialog__body' }, ...children),
      actions && actions.length ? h('div', { class: 'v-dialog__actions' }, actions) : null,
    )
    return h('div', { class: 'v-dialog__scrim', onClick: onClose }, dialog)
  }

  /**
   * Abre um diálogo modal: prende o foco, fecha com Esc, devolve o foco a quem o abriu.
   * Devolve { close, el }.
   */
  function openDialog(opts = {}, ...children) {
    const opener = document.activeElement
    let closed = false
    const dismissible = opts.dismissible !== false
    const close = (result) => {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', onKey, true)
      scrim.remove()
      if (opener && opener.focus) opener.focus()
      if (opts.onClose) opts.onClose(result)
    }
    const scrim = Dialog({ ...opts, onClose: dismissible ? () => close() : undefined }, ...children)
    function onKey(e) {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation()
        close()
      } else if (e.key === 'Tab') {
        const nodes = [...scrim.querySelectorAll(FOCUSABLE)]
        if (!nodes.length) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(scrim)
    const dialog = scrim.querySelector('.v-dialog')
    const target = scrim.querySelector('[data-autofocus]') || dialog
    target.focus()
    return { close, el: scrim }
  }

  /** Um toast. `variant`: navy | lead. Copy diz o desfecho, sem exclamação. */
  function Toast({ title, action, onAction, onClose, variant = 'navy', closeLabel = 'Dispensar', class: klass } = {}, ...children) {
    return h(
      'div',
      { role: 'status', class: cx('v-toast', variant !== 'navy' && `v-toast--${variant}`, klass) },
      h('div', { class: 'v-toast__body' }, title ? h('div', { class: 'v-toast__title' }, title) : null, h('p', { class: 'v-toast__text' }, ...children), action ? h('button', { type: 'button', class: 'v-toast__action', onClick: onAction }, action) : null),
      onClose ? h('button', { type: 'button', class: 'v-toast__close', 'aria-label': closeLabel, onClick: onClose }, Icon({ name: 'x', size: 16 })) : null,
    )
  }

  let region = null
  /** Mostra um toast na região viva do canto da tela e o remove sozinho (6s por padrão). */
  function toast(text, opts = {}) {
    if (!region || !region.isConnected) {
      region = h('div', { class: 'v-toasts', 'aria-live': 'polite' })
      document.body.appendChild(region)
    }
    let timer = null
    const dismiss = () => { clearTimeout(timer); el.remove() }
    const el = Toast({ title: opts.title, action: opts.action, onAction: () => { dismiss(); if (opts.onAction) opts.onAction() }, onClose: dismiss }, text)
    region.appendChild(el)
    timer = setTimeout(dismiss, opts.duration || 6000)
    return { dismiss, el }
  }

  /** Dica curta ao passar o mouse ou focar. `children` é o elemento-gatilho. Esc a dispensa. */
  function Tooltip({ label, placement = 'top', class: klass } = {}, ...children) {
    const id = uid('tip')
    const bubble = h('span', { role: 'tooltip', id, class: cx('v-tooltip__bubble', `v-tooltip__bubble--${placement}`) }, label)
    const wrap = h('span', { class: cx('v-tooltip', klass) }, ...children, bubble)
    const trigger = wrap.firstElementChild
    if (trigger && trigger !== bubble) trigger.setAttribute('aria-describedby', id)
    const show = () => bubble.classList.add('v-tooltip__bubble--visible')
    const hide = () => bubble.classList.remove('v-tooltip__bubble--visible')
    wrap.addEventListener('mouseenter', show)
    wrap.addEventListener('mouseleave', hide)
    wrap.addEventListener('focusin', show)
    wrap.addEventListener('focusout', hide)
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() })
    return wrap
  }

  Object.assign(VUI, { Dialog, openDialog, Toast, toast, Tooltip })
})(typeof globalThis !== 'undefined' ? globalThis : window)
