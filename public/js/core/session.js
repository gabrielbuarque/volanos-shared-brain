/**
 * Sessão e chamadas à API. Classic script.
 *
 * - O token mora em localStorage (sb_token) e vai só no header Authorization.
 * - Uma sessão encerrada por fora (conta suspensa, removida, token trocado) volta ao login
 *   com a razão dita em linguagem humana; vários 401 simultâneos geram um único aviso.
 * - "Ver como" (admin): enquanto houver uma pessoa escolhida, toda chamada leva X-View-As.
 *   O servidor aplica o MESMO filtro dessa pessoa; o front não simula nada.
 */
;(function (g) {
  const KEYS = { url: 'sb_url', token: 'sb_token', viewAs: 'sb_view_as' }

  /** Entrega do login por Google: #session=<token>&welcome=1 ou #invite=<token>. Consome e limpa o endereço. */
  function consumeFragment() {
    const out = { welcome: false, invite: null }
    try {
      const raw = String(window.location.hash || '').replace(/^#/, '')
      if (!raw || raw.startsWith('/')) return out
      const params = new URLSearchParams(raw)
      const session = params.get('session')
      const invite = params.get('invite')
      if (!session && !invite) return out
      if (session) {
        localStorage.setItem(KEYS.url, window.location.origin)
        localStorage.setItem(KEYS.token, session)
        out.welcome = params.get('welcome') === '1'
      }
      if (invite) out.invite = invite
      history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch (e) {
      /* storage bloqueado: a tela de entrada aparece */
    }
    return out
  }

  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.error) || `HTTP ${status}`)
      this.status = status
      this.data = data || {}
      this.code = (data && data.code) || ''
    }
  }

  const Session = {
    url: '',
    token: '',
    me: null,
    listeners: new Set(),
    ended: null,

    init() {
      const frag = consumeFragment()
      try {
        this.url = localStorage.getItem(KEYS.url) || window.location.origin
        this.token = localStorage.getItem(KEYS.token) || ''
      } catch (e) {
        this.url = window.location.origin
      }
      return frag
    },

    get viewAs() {
      try {
        return JSON.parse(sessionStorage.getItem(KEYS.viewAs) || 'null')
      } catch (e) {
        return null
      }
    },
    setViewAs(person) {
      try {
        if (person) sessionStorage.setItem(KEYS.viewAs, JSON.stringify(person))
        else sessionStorage.removeItem(KEYS.viewAs)
      } catch (e) {
        /* sem armazenamento: a visão vale só até recarregar */
      }
    },

    headers(extra) {
      const h = { Authorization: `Bearer ${this.token}`, ...(extra || {}) }
      const as = this.viewAs
      if (as && as.id) h['X-View-As'] = as.id
      return h
    },

    /** Chamada JSON. Lança ApiError com status, code e data. */
    async api(path, opts = {}) {
      const { method = 'GET', body, signal, raw = false } = opts
      const res = await fetch(`${this.url}${path}`, {
        method,
        signal,
        headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (raw) return res
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) this.end(data.code)
      if (!res.ok || data.ok === false) throw new ApiError(res.status, data)
      return data
    },

    /** Entrar com um token (dono ou membro). Valida contra o servidor antes de guardar. */
    async signIn(url, token) {
      const res = await fetch(`${url}/permissions/me`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await res.json().catch(() => ({}))
      if (res.status === 401) throw new ApiError(401, body)
      if (!res.ok) throw new ApiError(res.status, body)
      this.url = url
      this.token = token
      try {
        localStorage.setItem(KEYS.url, url)
        localStorage.setItem(KEYS.token, token)
      } catch (e) {
        /* a sessão vale até fechar a aba */
      }
      return body
    },

    /** Carrega quem sou eu. Sob "ver como", são os dados da pessoa escolhida. */
    async loadMe() {
      const me = await this.api('/permissions/me')
      this.me = me
      return me
    },

    get isAdmin() {
      return !!(this.me && this.me.role === 'admin' && !this.me.viewAs)
    },

    /** A sessão acabou por fora. Um único aviso, mesmo com várias chamadas falhando juntas. */
    end(code) {
      if (!this.token || this.ended) return
      this.ended = code || 'invalid_token'
      try { localStorage.removeItem(KEYS.token) } catch (e) { /* nada a limpar */ }
      this.token = ''
      this.setViewAs(null)
      for (const fn of this.listeners) fn(this.ended)
    },

    onEnd(fn) {
      this.listeners.add(fn)
    },

    signOut() {
      try {
        localStorage.removeItem(KEYS.token)
      } catch (e) { /* nada a limpar */ }
      this.setViewAs(null)
      this.token = ''
      this.me = null
      window.location.hash = ''
      window.location.reload()
    },
  }

  g.Session = Session
  g.ApiError = ApiError
})(typeof globalThis !== 'undefined' ? globalThis : window)
