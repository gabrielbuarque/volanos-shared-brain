// i18n do Shared Brain da Volanos (pt-BR e en). Classic script.
// Catálogos em js/i18n-pt.js (I18N_PT) e js/i18n-en.js (I18N_EN), carregados antes deste arquivo.
// Expõe: t, tPlural, initI18n, applyI18nDom, getLocale, setLocale, localeTag, formatDateUI, formatNumberUI.
// Voz: frases curtas, sem exclamação, sem emoji. test/ui/voice.test.ts confere os dois catálogos.

const SB_LOCALE_KEY = 'sb-locale'

const I18N_CATALOGS = { pt: typeof I18N_PT !== 'undefined' ? I18N_PT : {}, en: typeof I18N_EN !== 'undefined' ? I18N_EN : {} }

let currentLocale = 'pt'

function resolveI18nPath(messages, path) {
  let node = messages
  for (const part of String(path).split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

function interpolate(raw, params) {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, key) => (params[key] != null ? String(params[key]) : `{${key}}`))
}

/** Traduz uma chave com pontos. Aceita marcadores {nome}. Cai para pt e depois para a própria chave. */
function t(path, params) {
  let node = resolveI18nPath(I18N_CATALOGS[currentLocale], path)
  if (typeof node !== 'string') node = resolveI18nPath(I18N_CATALOGS.pt, path)
  if (typeof node !== 'string') return path
  return interpolate(node, params)
}

/** Plural: path.one / path.other com {n}. */
function tPlural(path, n, params) {
  const count = Number(n) || 0
  return t(`${path}.${count === 1 ? 'one' : 'other'}`, { n: String(count), ...(params || {}) })
}

function getLocale() {
  return currentLocale
}

function localeTag() {
  return currentLocale === 'en' ? 'en-US' : 'pt-BR'
}

/** Datas de interface. Não use para montar contexto de IA. */
function formatDateUI(value, options) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(localeTag(), options || { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatNumberUI(n) {
  return Number(n).toLocaleString(localeTag())
}

function readStoredLocale() {
  try {
    const stored = localStorage.getItem(SB_LOCALE_KEY)
    if (stored === 'en' || stored === 'pt') return stored
  } catch (_) {
    /* modo privado */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : '').toLowerCase()
  return nav.startsWith('en') ? 'en' : 'pt'
}

function initI18n(forceLocale) {
  currentLocale = forceLocale === 'en' || forceLocale === 'pt' ? forceLocale : readStoredLocale()
  try {
    localStorage.setItem(SB_LOCALE_KEY, currentLocale)
  } catch (_) {
    /* ignora */
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = currentLocale === 'en' ? 'en' : 'pt-BR'
  }
  return currentLocale
}

function setLocale(loc) {
  if (loc !== 'en' && loc !== 'pt') return
  try {
    localStorage.setItem(SB_LOCALE_KEY, loc)
  } catch (_) {
    /* ignora */
  }
  location.reload()
}

/**
 * Aplica data-i18n (textContent), data-i18n-html (innerHTML, só catálogo confiável) e
 * data-i18n-attr="placeholder|title|aria-label" no mesmo elemento.
 */
function applyI18nDom(root) {
  const scope = root || document
  if (!scope.querySelectorAll) return
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (!key) return
    const attrList = el.getAttribute('data-i18n-attr')
    if (attrList) {
      const text = t(key)
      attrList.split('|').forEach((attr) => {
        const name = attr.trim()
        if (name) el.setAttribute(name, text)
      })
      return
    }
    if (el.hasAttribute('data-i18n-html')) el.innerHTML = t(key)
    else el.textContent = t(key)
  })
}
