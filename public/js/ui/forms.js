/**
 * Volanos UI: formulários. Input, Select, Checkbox, Switch.
 * Seguem components/forms/*.prompt.md. Erro = borda navy mais grossa (3px) + texto, sem cor de alerta.
 */
;(function (g) {
  const VUI = (g.VUI = g.VUI || {})
  const { h, cx, uid, Icon } = VUI

  function fieldShell({ label, hint, error, id, control, class: klass, extra }) {
    const hintId = id + '-hint'
    const note = error ? h('span', { class: 'v-field__hint v-field__hint--error', id: hintId, role: 'alert' }, error) : hint ? h('span', { class: 'v-field__hint', id: hintId }, hint) : null
    if (note) control.setAttribute('aria-describedby', hintId)
    if (error) control.setAttribute('aria-invalid', 'true')
    const field = h('div', { class: cx('v-field', klass) }, label ? h('label', { class: 'v-field__label', for: id }, label) : null, extra || control, note)
    field.control = control
    return field
  }

  /** Campo de texto, com rótulo em caixa alta. `multiline` vira textarea. Devolve o wrapper; `.control` é o input. */
  function Input({ label, hint, error, multiline, id, class: klass, onInput, onChange, ...rest } = {}) {
    const fid = id || uid('input')
    const control = h(multiline ? 'textarea' : 'input', { id: fid, class: cx('v-control', multiline && 'v-control--textarea'), onInput, onChange, ...rest })
    return fieldShell({ label, hint, error, id: fid, control, class: klass })
  }

  /** Lista de opções: strings ou { value, label }. `value` escolhe a opção inicial. */
  function Select({ label, hint, error, options = [], value, id, class: klass, onChange, ...rest } = {}) {
    const fid = id || uid('select')
    const select = h('select', { id: fid, class: 'v-control', onChange, ...rest }, options.map((o) => (typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: String(o.value), disabled: o.disabled }, o.label))))
    if (value !== undefined && value !== null) select.value = String(value)
    const wrap = h('span', { class: 'v-select' }, select, h('span', { class: 'v-select__chev' }, Icon({ name: 'chevron-down', size: 18 })))
    return fieldShell({ label, hint, error, id: fid, control: select, class: klass, extra: wrap })
  }

  function choice({ label, checked, disabled, onChange, kind, class: klass, ...rest }) {
    const input = h('input', { type: 'checkbox', checked: !!checked, disabled: !!disabled, onChange, ...(kind === 'switch' ? { role: 'switch' } : {}), ...rest })
    const visual =
      kind === 'switch'
        ? h('span', { class: 'v-switch__track', 'aria-hidden': 'true' }, h('span', { class: 'v-switch__knob' }))
        : h('span', { class: 'v-choice__box', 'aria-hidden': 'true' }, Icon({ name: 'check-line', size: 14, class: 'v-choice__mark' }))
    const el = h('label', { class: cx('v-choice', kind === 'switch' && 'v-switch', disabled && 'v-choice--disabled', klass) }, input, visual, label ? h('span', null, label) : null)
    el.input = input
    return el
  }

  /** Caixa de seleção. Devolve o <label>; `.input` é o checkbox. */
  function Checkbox(props = {}) {
    return choice({ ...props, kind: 'check' })
  }

  /** Interruptor (role=switch). Devolve o <label>; `.input` é o checkbox. */
  function Switch(props = {}) {
    return choice({ ...props, kind: 'switch' })
  }

  Object.assign(VUI, { Input, Select, Checkbox, Switch })
})(typeof globalThis !== 'undefined' ? globalThis : window)
