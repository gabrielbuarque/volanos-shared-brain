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

  const REASONS = ['edit', 'merge', 'merge-superseded', 'compact', 'archive', 'restore', 'import']

  /** Histórico: cada versão anterior com o que mudou depois dela; restaurar volta o texto como uma nova versão. */
  async function historySection(entry, reload) {
    const box = h('section', { class: 'doc__history', 'aria-label': t('history.title') }, Eyebrow({}, t('history.title')), Parts.Skeleton({ lines: 2 }))
    try {
      const { versions } = await Session.api('/entry/versions?id=' + encodeURIComponent(entry.id))
      const current = (versions[0] ? versions[0].version : 0) + 1
      const items = versions.map((v, i) => {
        const newer = i === 0 ? entry.content : versions[i - 1].content
        const reason = REASONS.includes(v.reason) ? t('history.reason.' + v.reason) : v.reason
        const body = [
          h('p', { class: 'v-caption' }, t('history.diffFrom')),
          Parts.Diff(v.content, newer),
          entry.can_edit ? h('div', { class: 'state__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: () => restoreDialog(entry, v, reload) }, t('history.restore'))) : null,
        ]
        return h('details', { class: 'history__item' },
          h('summary', null, t('history.version', { n: v.version }), ' · ', reason, ' · ', Parts.authorName(v.actor_name), ' · ', formatDateUI(v.created_at)),
          ...body)
      })
      mount(box, Eyebrow({}, t('history.title')),
        h('p', { class: 'source__meta' }, t('history.current', { n: current })),
        items.length ? h('div', { class: 'history__list' }, items) : h('p', { class: 'v-caption' }, t('history.empty')))
    } catch (e) { mount(box) }
    return box
  }

  function editDialog(entry, reload) {
    const isAdmin = Session.me && Session.me.role === 'admin'
    const text = g.VUI.Input({ multiline: true, rows: 14, label: t('doc.editText'), hint: isAdmin ? t('doc.editHintDirect') : t('doc.editHint'), value: entry.content, 'data-autofocus': '' })
    const err = h('div', { 'aria-live': 'polite' })
    const save = Button({ onClick: async () => {
      const next = text.control.value.trim()
      if (!next) { text.setError(t('doc.editEmpty')); return }
      if (next === entry.content.trim()) { text.setError(t('doc.editSame')); return }
      save.disabled = true
      try {
        const r = await Session.api('/entry/propose-edit', { method: 'POST', body: { id: entry.id, content: next } })
        d.close()
        if (r.applied) { g.VUI.toast(t('doc.saved')); reload() } else g.VUI.toast(r.owner && r.owner.name ? t('doc.proposed', { owner: r.owner.name }) : t('doc.proposedPlain'), { title: t('doc.proposedTitle') })
      } catch (e) { save.disabled = false; mount(err, Parts.ErrorState({})) }
    } }, t(isAdmin ? 'doc.save' : 'doc.propose'))
    text.control.addEventListener('input', () => text.clearError())
    const d = g.VUI.openDialog({ title: t(isAdmin ? 'doc.editTitle' : 'doc.proposeTitle') }, text, err, h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), save))
  }

  function restoreDialog(entry, v, reload) {
    const d = g.VUI.openDialog({ title: t('history.restoreTitle', { n: v.version }) }, h('p', null, t('history.restoreBody', { n: v.version })),
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), Button({ onClick: async () => {
        try { await Session.api('/entry/restore', { method: 'POST', body: { id: entry.id, version: v.version } }); d.close(); g.VUI.toast(t('history.restored')); reload() } catch (e) { g.VUI.toast(t('error.body'), { title: t('error.title') }) }
      } }, t('history.restore'))))
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
        h('div', { class: 'page-head__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: () => g.ClaudeDialog.open({ clientName, ids: [entry.id], question: Fmt.titleOf(entry.content) }) }, t('ask.action.claude')), entry.workspace === 'company' && !Session.viewAs ? Button({ variant: 'secondary', size: 'sm', onClick: () => editDialog(entry, () => renderDoc(host, id)) }, t(Session.me && Session.me.role === 'admin' ? 'doc.edit' : 'doc.propose')) : null),
        await historySection(entry, () => renderDoc(host, id)),
      ))
  }

  g.ClientsScreen = { render(host, parts) { return parts[0] ? renderClient(host, parts[0]) : renderList(host) } }
  g.DocScreen = { render(host, parts) { return renderDoc(host, parts[0]) } }
})(typeof globalThis !== 'undefined' ? globalThis : window)
