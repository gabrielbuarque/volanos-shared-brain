/**
 * Shell do app: topo fixo (logo, seletor de cliente, perfil com o nível P), quatro áreas
 * (Perguntar, Clientes, Contribuir, Admin) e roteador por hash.
 *
 * Rotas: #/perguntar (padrão), #/clientes, #/clientes/<id>, #/doc/<id>, #/contribuir, #/admin[/<aba>].
 * Admin só aparece para admin. Sob "ver como", o topo ganha uma faixa fixa e o Admin some.
 */
;(function (g) {
  const { h, mount, Button, Select, LevelPill, Logo, Tabs } = g.VUI
  const { Session, App } = g

  const NAV = [
    { id: 'perguntar', label: 'nav.ask', screen: 'AskScreen' },
    { id: 'clientes', label: 'nav.clients', screen: 'ClientsScreen' },
    { id: 'contribuir', label: 'nav.contribute', screen: 'ContributeScreen' },
    { id: 'admin', label: 'nav.admin', screen: 'AdminScreen', admin: true },
  ]

  let realMe = null
  let viewEl

  function parseRoute() {
    const parts = String(window.location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    return { area: parts[0] || 'perguntar', parts: parts.slice(1) }
  }

  function canSee(item) {
    return !item.admin || (realMe && realMe.role === 'admin' && !Session.viewAs)
  }

  function navLinks(area) {
    return NAV.filter(canSee).map((n) => h('a', { class: 'topbar__link', href: `#/${n.id}`, 'aria-current': n.id === area || (area === 'doc' && n.id === 'clientes') ? 'page' : undefined }, t(n.label)))
  }

  function clientSelect() {
    const options = [...App.clients.map((c) => ({ value: c.id, label: c.name })), { value: App.INTERNAL, label: t('client.internal') }]
    const wrap = Select({ options, value: App.activeClient, class: 'topbar__client', 'aria-label': t('shell.clientLabel'), onChange: (e) => { App.setClient(e.target.value); route() } })
    return wrap
  }

  function openProfile() {
    const me = Session.me
    const levelText = App.levelText(me.clearanceFloor)
    const loc = getLocale()
    const tabs = Tabs({ variant: 'pill', label: t('shell.language'), value: loc, items: [{ id: 'pt', label: 'PT-BR' }, { id: 'en', label: 'EN' }], onChange: (id) => setLocale(id) })
    const d = g.VUI.openDialog({ title: t('shell.account') },
      h('p', null, h('strong', null, me.name || t('common.you')), me.email ? [' · ', me.email] : null),
      h('p', null, LevelPill({ level: me.clearanceFloor }), ' ', h('span', { class: 'v-caption' }, levelText)),
      h('div', { class: 'v-field' }, h('span', { class: 'v-field__label' }, t('shell.language')), tabs),
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.close')), Button({ variant: 'secondary', onClick: () => Session.signOut() }, t('shell.signOut'))),
    )
  }

  function viewAsBanner() {
    const as = Session.viewAs
    if (!as) return null
    return h('div', { class: 'viewas', role: 'status' },
      h('span', null, t('viewas.banner', { name: as.name, level: `P${as.clearanceFloor}` })),
      Button({ variant: 'secondary', size: 'sm', onClick: () => exitViewAs() }, t('viewas.exit')))
  }

  function chrome(area) {
    const me = Session.me
    return [
      h('header', { class: 'topbar' },
        h('a', { class: 'topbar__brand', href: '#/perguntar', 'aria-label': t('shell.home') }, Logo({ width: 128 })),
        h('nav', { class: 'topbar__nav', 'aria-label': t('shell.nav') }, navLinks(area)),
        h('div', { class: 'topbar__tools' }, clientSelect(),
          h('button', { type: 'button', class: 'topbar__profile', onClick: openProfile, 'aria-label': t('shell.account') }, LevelPill({ level: me.clearanceFloor, size: 'sm' }), h('span', { class: 'topbar__name' }, me.name || t('common.you')))),
      ),
      viewAsBanner(),
    ]
  }

  function route() {
    const { area, parts } = parseRoute()
    const root = document.getElementById('app')
    const view = h('main', { class: 'view', id: 'view', tabindex: '-1' })
    viewEl = view
    mount(root, ...chrome(area), view)
    document.body.classList.toggle('is-viewas', !!Session.viewAs)
    const item = NAV.find((n) => n.id === area)
    let screen = item && canSee(item) ? g[item.screen] : null
    if (area === 'doc') screen = g.DocScreen
    if (!screen) { window.location.hash = '#/perguntar'; return }
    screen.render(view, parts)
    document.title = t('shell.title')
  }

  async function refreshAll() {
    await Session.loadMe()
    await App.load()
  }

  /** "Ver como": o servidor passa a responder com o nível e os clientes da pessoa. Nada é simulado aqui. */
  async function enterViewAs(person) {
    await Session.api('/admin/view-as/start', { method: 'POST', body: { id: person.id } })
    Session.setViewAs({ id: person.id, name: person.name, clearanceFloor: person.clearanceFloor })
    g.AskScreen.reset()
    await refreshAll()
    window.location.hash = '#/perguntar'
    route()
  }

  async function exitViewAs() {
    Session.setViewAs(null)
    g.AskScreen.reset()
    await refreshAll()
    route()
  }

  async function boot() {
    initI18n()
    applyI18nDom()
    const frag = Session.init()
    const loginHost = document.getElementById('login')
    const appHost = document.getElementById('app')
    const showLogin = (reason) => {
      appHost.hidden = true
      loginHost.hidden = false
      g.LoginScreen.render(loginHost, { reason, invite: frag.invite, onSignedIn: start })
    }
    Session.onEnd((code) => showLogin(code))
    async function start() {
      try {
        realMe = null
        await Session.loadMe()
        // Quem entra já como admin pode ter ficado numa visão de outra pessoa: começa limpo.
        if (Session.viewAs) { Session.setViewAs(null); await Session.loadMe() }
        realMe = Session.me
        await App.load()
      } catch (e) {
        showLogin(e && e.code)
        return
      }
      loginHost.hidden = true
      appHost.hidden = false
      route()
      if (frag.welcome) { frag.welcome = false; g.LoginScreen.welcome() }
    }
    window.addEventListener('hashchange', () => { if (Session.token && !appHost.hidden) route() })
    App.onClientChange(() => { /* a tela atual refaz o que depende do cliente */ })
    if (Session.token) start()
    else showLogin()
  }

  g.Shell = { boot, route, enterViewAs, exitViewAs, refreshAll, realMe: () => realMe }
})(typeof globalThis !== 'undefined' ? globalThis : window)
