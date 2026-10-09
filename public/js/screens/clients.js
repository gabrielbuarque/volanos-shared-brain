/**
 * Clientes: lista com owner e última atualização; página do cliente com o Canon em primeiro plano e as
 * fontes brutas numa aba, filtradas por nível; leitura de documento em layout editorial.
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, LevelPill, Tabs, Select, Tag } = g.VUI
  const { Parts, Fmt, App, Session } = g

  function backLink(label) {
    return h('a', { class: 'backlink', href: '#/clientes' }, '← ', label)
  }

  function ownerLine(c) {
    return c.owner && c.owner.name ? t('clients.owner', { name: c.owner.name }) : t('clients.noOwner')
  }

  function clientRow(c) {
    return h('a', { class: 'clientrow', href: `#/clientes/${encodeURIComponent(c.id)}` },
      Card({ variant: 'outline', interactive: true, class: 'clientrow__card' },
        h('h3', { class: 'clientrow__name' }, c.name),
        h('p', { class: 'clientrow__meta' }, ownerLine(c)),
        h('p', { class: 'clientrow__meta' }, c.updated_at ? t('clients.updated', { when: Fmt.relativeTime(c.updated_at) }) : t('clients.neverUpdated'), ' · ', tPlural('clients.sources', c.sources)),
      ))
  }

  async function renderList(host) {
    mount(host, h('div', { class: 'page-head' }, Eyebrow({}, t('nav.clients')), h('h1', null, t('clients.title'))), Parts.Skeleton({ lines: 4 }))
    try {
      await App.load()
    } catch (e) {
      mount(host, h('div', { class: 'page-head' }, h('h1', null, t('clients.title'))), Parts.ErrorState({ onRetry: () => renderList(host) }))
      return
    }
    const rows = App.clients.map(clientRow)
    const internal = { id: App.INTERNAL, name: t('client.internal'), owner: null, sources: App.internal.sources, updated_at: App.internal.updated_at }
    rows.push(clientRow(internal))
    mount(host,
      h('div', { class: 'page-head' }, Eyebrow({}, t('nav.clients')), h('h1', null, t('clients.title')), h('p', { class: 'v-caption' }, t('clients.intro'))),
      App.clients.length ? h('div', { class: 'clientlist' }, rows) : Parts.EmptyState({ title: t('clients.emptyTitle'), body: t('clients.emptyBody'), actions: [Button({ variant: 'secondary', size: 'sm', href: '#/contribuir' }, t('nav.contribute'))] }),
      App.clients.length ? null : h('div', { class: 'clientlist' }, rows),
    )
  }

  function canonItem(e) {
    return h('a', { class: 'canonitem', href: `#/doc/${encodeURIComponent(e.id)}` },
      h('h3', { class: 'v-title-canon canonitem__title' }, Fmt.titleOf(e.content)),
      h('p', { class: 'canonitem__excerpt' }, Fmt.bodyOf(e.content).slice(0, 220)),
      h('p', { class: 'source__meta' }, Parts.authorName(e.author), ' · ', Fmt.relativeTime(e.updated_at), ' · ', Fmt.sourceKindLabel(e.source)),
      h('div', { class: 'source__tags' }, Parts.ReviewTag(e.review_state), LevelPill({ level: e.clearance_level, text: App.levelText(e.clearance_level), size: 'sm' }), e.stale ? Tag({ variant: 'outline', class: 'source__stale' }, t('source.stale')) : null),
    )
  }

  async function renderClient(host, id) {
    mount(host, backLink(t('clients.title')), Parts.Skeleton({ lines: 4 }))
    const state = { tab: 'canon', level: '' }
    let canon, sources
    const name = App.clientName(id)
    const panel = h('div', { class: 'clientpage__panel', role: 'tabpanel' })

    async function load(view, level) {
      const q = new URLSearchParams({ client: id, view, n: '100' })
      if (level !== '' && level !== undefined) q.set('level', level)
      return Session.api('/client/entries?' + q)
    }

    function paint() {
      if (state.tab === 'canon') {
        mount(panel, canon.entries.length
          ? h('div', { class: 'canonlist' }, canon.entries.map(canonItem))
          : Parts.EmptyState({ title: t('clients.canonEmptyTitle'), body: t('clients.canonEmptyBody', { client: name }), actions: [
            Button({ variant: 'secondary', size: 'sm', onClick: () => { App.setClient(id); window.location.hash = '#/perguntar' } }, t('clients.ask', { client: name })),
            Button({ variant: 'ghost', size: 'sm', href: '#/contribuir' }, t('nav.contribute')),
          ] }))
        return
      }
      const levels = [{ value: '', label: t('clients.allLevels') }, ...Array.from({ length: 13 }, (_, n) => n).filter((n) => n >= (Session.me.clearanceFloor || 0)).map((n) => ({ value: String(n), label: `P${n}` }))]
      const filter = Select({ label: t('clients.level'), options: levels, value: state.level, class: 'clientpage__filter', onChange: async (e) => {
        state.level = e.target.value
        mount(panel, Parts.Skeleton({ lines: 3 }))
        try { sources = await load('sources', state.level); paint() } catch (err) { mount(panel, Parts.ErrorState({ onRetry: paint })) }
      } })
      mount(panel, filter,
        sources.entries.length ? h('div', { class: 'turn__source-grid' }, sources.entries.map((s) => Parts.SourceCard(s))) : Parts.EmptyState({ title: t('clients.sourcesEmptyTitle'), body: t('clients.sourcesEmptyBody') }))
    }

    try {
      ;[canon, sources] = await Promise.all([load('canon'), load('sources')])
    } catch (e) {
      mount(host, backLink(t('clients.title')), e && e.status === 404 ? Parts.EmptyState({ title: t('clients.notFoundTitle'), body: t('clients.notFoundBody') }) : Parts.ErrorState({ onRetry: () => renderClient(host, id) }))
      return
    }
    const head = canon.client || { owner: null }
    const tabs = Tabs({ label: t('clients.tabs'), value: 'canon', items: [{ id: 'canon', label: t('clients.canon') }, { id: 'sources', label: t('clients.sourcesTab') }], onChange: (tab) => { state.tab = tab; paint() } })
    mount(host,
      backLink(t('clients.title')),
      h('div', { class: 'page-head' },
        Eyebrow({}, t('clients.client')), h('h1', null, name),
        h('p', { class: 'v-caption' }, id === App.INTERNAL ? t('clients.internalNote') : ownerLine(head)),
        h('div', { class: 'page-head__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: () => { App.setClient(id); window.location.hash = '#/perguntar' } }, t('clients.ask', { client: name }))),
      ),
      tabs, panel)
    paint()
  }

  /** Leitura de documento: título em Merriweather, corpo em Montserrat, regras finas, medida de até 820px. */
  async function renderDoc(host, id) {
    mount(host, backLink(t('clients.title')), Parts.Skeleton({ lines: 6 }))
    let entry
    try {
      entry = (await Session.api('/entry?id=' + encodeURIComponent(id))).entry
    } catch (e) {
      mount(host, backLink(t('clients.title')), e && e.status === 404 ? Parts.EmptyState({ title: t('doc.notFoundTitle'), body: t('doc.notFoundBody') }) : Parts.ErrorState({ onRetry: () => renderDoc(host, id) }))
      return
    }
    const clientName = App.clientName(entry.client_id || App.INTERNAL)
    const stale = Date.now() - Number(entry.updated_at) > Parts.STALE_DAYS * 86400000
    mount(host,
      h('a', { class: 'backlink', href: entry.client_id ? `#/clientes/${encodeURIComponent(entry.client_id)}` : '#/clientes' }, '← ', clientName),
      h('article', { class: 'doc' },
        Eyebrow({}, clientName),
        h('h1', { class: 'v-title-canon doc__title' }, Fmt.titleOf(entry.content, 200)),
        h('p', { class: 'source__meta' }, Parts.authorName(entry.actor_name), ' · ', formatDateUI(entry.updated_at), ' · ', Fmt.sourceKindLabel(entry.source)),
        h('div', { class: 'source__tags' }, Parts.ReviewTag(entry.review_state), LevelPill({ level: entry.clearance_level, text: App.levelText(entry.clearance_level), size: 'sm' }), stale ? Tag({ variant: 'outline', class: 'source__stale' }, t('source.stale')) : null),
        h('hr', { class: 'v-rule doc__top' }),
        Fmt.renderDocument(entry.content),
        h('div', { class: 'page-head__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: () => g.ClaudeDialog.open({ clientName, ids: [entry.id], question: Fmt.titleOf(entry.content) }) }, t('ask.action.claude'))),
      ))
  }

  g.ClientsScreen = { render(host, parts) { return parts[0] ? renderClient(host, parts[0]) : renderList(host) } }
  g.DocScreen = { render(host, parts) { return renderDoc(host, parts[0]) } }
})(typeof globalThis !== 'undefined' ? globalThis : window)
