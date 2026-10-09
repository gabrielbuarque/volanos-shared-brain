/**
 * Volanos UI: criação de elementos. Classic script, sem dependências.
 *
 * Os componentes de public/js/ui/ são funções que devolvem elementos DOM. Nada aqui
 * monta HTML por concatenação de string: texto entra como nó de texto, então um título
 * de documento ou um nome de pessoa nunca vira marcação.
 *
 *   VUI.h('div', { class: 'x', onClick: fn, 'aria-label': 'y' }, 'texto', outroNo)
 */
;(function (g) {
  const VUI = (g.VUI = g.VUI || {})
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g'])
  /** Propriedades que precisam ir pelo objeto, não pelo atributo, para refletir o estado vivo. */
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate'])

  function append(el, child) {
    if (child === null || child === undefined || child === false || child === true) return
    if (Array.isArray(child)) {
      for (const c of child) append(el, c)
      return
    }
    el.appendChild(typeof child === 'object' && child.nodeType ? child : document.createTextNode(String(child)))
  }

  function h(tag, props, ...children) {
    const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)
    for (const [key, val] of Object.entries(props || {})) {
      if (val === undefined || val === null || val === false) continue
      if (key === 'class' || key === 'className') el.setAttribute('class', Array.isArray(val) ? val.filter(Boolean).join(' ') : String(val))
      else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val)
      else if (key === 'dataset' && typeof val === 'object') Object.assign(el.dataset, val)
      else if (/^on[A-Z]/.test(key) && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val)
      else if (PROPS.has(key)) el[key] = val
      else if (val === true) el.setAttribute(key, '')
      else el.setAttribute(key, String(val))
    }
    for (const c of children) append(el, c)
    return el
  }

  /** Junta classes ignorando vazios. */
  function cx(...parts) {
    return parts.filter(Boolean).join(' ')
  }

  let idCounter = 0
  /** Id único para ligar rótulo e campo. */
  function uid(prefix) {
    idCounter += 1
    return `${prefix || 'v'}-${idCounter}`
  }

  /** Esvazia um elemento e põe o conteúdo novo. */
  function mount(host, ...children) {
    while (host.firstChild) host.removeChild(host.firstChild)
    for (const c of children) append(host, c)
    return host
  }

  VUI.h = h
  VUI.cx = cx
  VUI.uid = uid
  VUI.mount = mount
})(typeof globalThis !== 'undefined' ? globalThis : window)
