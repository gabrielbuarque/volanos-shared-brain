/**
 * Estado compartilhado do app: pessoa, clientes acessíveis, cliente ativo, textos dos níveis.
 * O cliente ativo é guardado POR USUÁRIO (sb_client:<userId>): duas pessoas no mesmo navegador
 * não herdam a escolha uma da outra.
 */
;(function (g) {
  const INTERNAL = 'internal'
  // "Todos os clientes": sem escopo de cliente. Continua dentro do nível e do espaço de quem pergunta.
  const ALL = 'all'

  const App = {
    INTERNAL,
    ALL,
    clients: [],
    internal: { sources: 0, updated_at: null },
    levels: [],
    activeClient: ALL,
    listeners: new Set(),

    storageKey() {
      return 'sb_client:' + ((g.Session.me && g.Session.me.userId) || 'anon')
    },

    async load() {
      const [clients, levels] = await Promise.all([g.Session.api('/clients'), g.Session.api('/levels').catch(() => ({ levels: [] }))])
      this.clients = clients.clients || []
      this.internal = clients.internal || this.internal
      this.levels = levels.levels || []
      let saved = null
      try { saved = localStorage.getItem(this.storageKey()) } catch (e) { /* sem armazenamento */ }
      this.activeClient = saved && (saved === INTERNAL || saved === ALL || this.clients.some((c) => c.id === saved)) ? saved : ALL
    },

    /** Valor do parâmetro ?client= do /recall: vazio quando a busca é em todos os clientes. */
    scopeParam(id) {
      return id === ALL ? '' : id
    },

    /** Opções do seletor de cliente (topo, Perguntar). Contribuir e Canon não usam "todos". */
    scopeOptions() {
      return [{ value: ALL, label: t('client.all') }, ...this.clients.map((c) => ({ value: c.id, label: c.name })), { value: INTERNAL, label: t('client.internal') }]
    },

    clientById(id) {
      return this.clients.find((c) => c.id === id) || null
    },

    /** Nome para mostrar. O interno vem do catálogo. */
    clientName(id) {
      if (id === ALL) return t('client.all')
      if (!id || id === INTERNAL) return t('client.internal')
      const c = this.clientById(id)
      return c ? c.name : t('client.unknown')
    },

    setClient(id) {
      if (id === this.activeClient) return
      this.activeClient = id
      try { localStorage.setItem(this.storageKey(), id) } catch (e) { /* a escolha vale até recarregar */ }
      for (const fn of this.listeners) fn(id)
    },

    onClientChange(fn) {
      this.listeners.add(fn)
      return () => this.listeners.delete(fn)
    },

    /** Texto do nível para tooltip: "Quem. O que lê. Exemplo." */
    levelText(level) {
      const l = this.levels[level]
      return l ? `${l.holders}. ${l.reads}. ${t('level.example')}: ${l.example}.` : ''
    },
  }

  g.App = App
})(typeof globalThis !== 'undefined' ? globalThis : window)
