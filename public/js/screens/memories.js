/**
 * Memórias: o que a interface anterior chamava de Memories e Team, na interface nova.
 * Abas: Recentes (lista com filtros e seleção em lote), Grafo, Resumo (resumo do dia, padrões, itens desatualizados),
 * Atividade (só admin) e Equipe. Rota: #/memorias[/<aba>].
 */
;(function (g) {
  const { h, mount, Button, Eyebrow, Select, Tabs, Tag } = g.VUI
  const { Parts, App, Session, Fmt, Legacy } = g

  const state = { entries: [], loaded: false, tag: '', time: '', layer: '', level: '', actor: '', selectMode: false, selected: new Set(), busy: false, authors: null, tags: [] }

  const TIME_OPTIONS = () => [{ value: '', label: t('mem.allTime') }, { value: 'today', label: t('mem.today') }, { value: '7', label: t('mem.last7') }, { value: '30', label: t('mem.last30') }, { value: 'month', label: t('mem.thisMonth') }]
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

  function filtered() {
    let rows = state.entries
    if (state.tag) rows = rows.filter((e) => g.MemoryUI.tagsOf(e).some((x) => String(x).toLowerCase() === state.tag.toLowerCase()))
    if (state.time) {
      const now = new Date()
      const cutoff = state.time === 'today' ? startOfDay(now).getTime() : state.time === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : Date.now() - Number(state.time) * 86400000
      rows = rows.filter((e) => Number(e.created_at) >= cutoff)
    }
    if (state.level !== '') rows = rows.filter((e) => Number(e.clearance_level) === Number(state.level))
    return rows
  }

  /** Agrupa por dia (hoje, ontem, data) e, depois de uma semana, por semana. */
  function grouped(rows) {
    const out = new Map()
    const now = new Date()
    const today = dayKey(now)
    const yesterday = dayKey(new Date(now - 86400000))
    for (const e of rows) {
      const d = new Date(Number(e.created_at))
      const k = dayKey(d)
      let label
      if (k === today) label = t('mem.today')
      else if (k === yesterday) label = t('mem.yesterday')
      else if (Number(e.created_at) >= Date.now() - 7 * 86400000) label = formatDateUI(d, { month: 'short', day: 'numeric' })
      else {
        const dow = d.getDay()
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (dow === 0 ? -6 : 1 - dow))
        label = t('mem.weekOf', { date: formatDateUI(monday, { month: 'short', day: 'numeric' }) })
      }
      if (!out.has(label)) out.set(label, [])
      out.get(label).push(e)
    }
    return out
  }

  async function loadAuthors() {
    if (state.authors || !App.team) return
    try { state.authors = await Session.api('/team/roster') } catch (e) { state.authors = { members: [], you: null } }
  }

  async function load(host) {
    if (!state.loaded) mount(host.list, Parts.Skeleton({ lines: 4 }))
    try {
      const q = new URLSearchParams({ n: '50' })
      if (state.layer) q.set('workspace', state.layer)
      if (state.layer === 'company' && state.actor) q.set('actor', state.actor)
      const [rows, tags] = await Promise.all([Session.api('/list?' + q), Session.api('/tags').catch(() => []), loadAuthors()])
      state.entries = Array.isArray(rows) ? rows : []
      state.tags = Legacy.humanTags(Array.isArray(tags) ? tags : [])
      state.loaded = true
      paint(host)
    } catch (e) {
      if (!state.loaded) mount(host.list, Parts.ErrorState({ onRetry: () => load(host) }))
    }
  }

  const reload = (host) => () => { state.loaded = state.entries.length > 0; load(host) }

  /** Mover em lote. Não existe rota em lote de propósito: cada linha passa pela mesma regra de quem pode mover o quê. */
  function bulkMove(host, target) {
    const ids = filtered().filter((e) => state.selected.has(e.id)).map((e) => e.id)
    if (!ids.length || state.busy) return
    const sharing = target === 'company'
    const d = g.VUI.openDialog({ title: tPlural(sharing ? 'mem.bulkShareTitle' : 'mem.bulkPrivateTitle', ids.length, { n: ids.length }) }, h('p', null, t(sharing ? 'mem.bulkShareBody' : 'mem.bulkPrivateBody')),
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), Button({ onClick: async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        state.busy = true
        let moved = 0
        const refused = []
        for (let i = 0; i < ids.length; i++) {
          btn.textContent = t('mem.bulkWorking', { done: i + 1, total: ids.length })
          try { await Session.api('/share', { method: 'POST', body: { id: ids[i], workspace: target } }); moved++; state.selected.delete(ids[i]) } catch (err) { refused.push(ids[i]) }
        }
        state.busy = false
        d.close()
        g.VUI.toast(moved === 0 ? t('mem.bulkNone') : refused.length ? `${tPlural('mem.bulkMoved', moved, { n: moved })} · ${tPlural('mem.bulkRefused', refused.length, { n: refused.length })}` : tPlural('mem.bulkMoved', moved, { n: moved }))
        reload(host)()
      } }, t(sharing ? 'mem.shareWithTeam' : 'mem.makePrivate'))))
  }

  function paint(host) {
    const rows = filtered()
    const levelCounts = new Map()
    state.entries.forEach((e) => { const n = Number(e.clearance_level); if (Number.isInteger(n)) levelCounts.set(n, (levelCounts.get(n) || 0) + 1) })
    const levelOptions = [{ value: '', label: t('mem.allLevels') }, ...[...levelCounts.keys()].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `P${n} · ${levelCounts.get(n)}` }))]
    const authors = state.authors ? [{ value: '', label: t('mem.allAuthors') }, ...state.authors.members.map((m) => ({ value: m.userId, label: m.userId === state.authors.you ? t('mem.authorYou') : m.name }))] : null

    const filters = h('div', { class: 'mem-filters' },
      Select({ label: t('mem.tag'), options: [{ value: '', label: t('mem.allTags') }, ...state.tags.map((x) => ({ value: x, label: x }))], value: state.tag, onChange: (e) => { state.tag = e.target.value; paint(host) } }),
      Select({ label: t('mem.time'), options: TIME_OPTIONS(), value: state.time, onChange: (e) => { state.time = e.target.value; paint(host) } }),
      App.team ? Select({ label: t('mem.layer'), options: [{ value: '', label: t('mem.allLayers') }, { value: 'personal', label: t('mem.personalLayer') }, { value: 'company', label: t('mem.sharedLayer') }], value: state.layer, onChange: (e) => { state.layer = e.target.value; if (state.layer !== 'company') state.actor = ''; load(host) } }) : null,
      levelCounts.size > 1 || state.level !== '' ? Select({ label: t('mem.level'), options: levelOptions, value: state.level, onChange: (e) => { state.level = e.target.value; paint(host) } }) : null,
      App.team && state.layer === 'company' && authors ? Select({ label: t('mem.author'), options: authors, value: state.actor, onChange: (e) => { state.actor = e.target.value; load(host) } }) : null)

    const picked = rows.filter((e) => state.selected.has(e.id)).length
    const bar = App.team ? h('div', { class: 'mem-bulk' },
      Button({ variant: 'secondary', size: 'sm', onClick: () => { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected.clear(); paint(host) } }, t(state.selectMode ? 'mem.selectExit' : 'mem.select')),
      state.selectMode ? [
        h('span', { class: 'v-caption', 'aria-live': 'polite' }, tPlural('mem.selectedCount', picked, { n: picked })),
        Button({ variant: 'ghost', size: 'sm', onClick: () => { rows.forEach((e) => state.selected.add(e.id)); paint(host) } }, t('mem.selectAll')),
        Button({ variant: 'ghost', size: 'sm', onClick: () => { state.selected.clear(); paint(host) } }, t('mem.selectClear')),
        Button({ variant: 'secondary', size: 'sm', disabled: !picked || state.busy, onClick: () => bulkMove(host, 'company') }, t('mem.shareWithTeam')),
        Button({ variant: 'secondary', size: 'sm', disabled: !picked || state.busy, onClick: () => bulkMove(host, 'personal') }, t('mem.makePrivate'))] : null) : null

    let body
    if (!rows.length) {
      body = state.entries.length ? Parts.EmptyState({ title: t('mem.emptyFilterTitle'), body: t('mem.emptyFilterBody') }) : Parts.EmptyState({ title: t('mem.emptyTitle'), body: t('mem.emptyBody'), actions: [Button({ size: 'sm', href: '#/contribuir' }, t('nav.contribute'))] })
    } else {
      body = [...grouped(rows)].map(([label, group]) => h('section', { class: 'mem-group' }, Eyebrow({}, label), h('div', { class: 'mem-cards' }, group.map((e) => g.MemoryUI.card(e, {
        onChanged: reload(host), selectable: state.selectMode, selected: state.selected.has(e.id),
        onSelect: (on) => { on ? state.selected.add(e.id) : state.selected.delete(e.id); paint(host) },
      })))))
    }
    const sharedHere = state.entries.some((e) => e.workspace === 'company')
    mount(host.list, filters, bar, sharedHere && App.team ? h('p', { class: 'turn__note' }, t('mem.coachLock')) : null, body)
  }

  function recentTab(el) {
    const host = { list: h('div', { class: 'mem-list' }) }
    mount(el, host.list)
    if (state.loaded) paint(host)
    load(host)
  }

  /* ---------- Casca ---------- */

  const TABS = () => [
    { id: 'recentes', label: t('mem.tabRecent') },
    { id: 'grafo', label: t('mem.tabGraph') },
    { id: 'resumo', label: t('mem.tabBrief') },
    ...(Session.me && Session.me.role === 'admin' && !Session.viewAs ? [{ id: 'atividade', label: t('mem.tabActivity') }] : []),
    { id: 'equipe', label: t('mem.tabTeam') },
  ]

  function render(host, parts) {
    let tab = parts[0] || 'recentes'
    if (!TABS().some((x) => x.id === tab)) tab = 'recentes'
    const body = h('div', { class: 'mem-body' })
    const tabs = Tabs({ label: t('mem.tabs'), value: tab, items: TABS(), onChange: (id) => { window.location.hash = `#/memorias/${id}` } })
    const count = App.count
    mount(host,
      h('div', { class: 'page-head' }, Eyebrow({}, t('nav.memories')), h('h1', null, t('mem.title')),
        h('p', { class: 'v-caption' }, count ? tPlural('mem.statusCount', count, { n: formatNumberUI(count) }) : t('mem.statusEmpty'), App.teamName ? ` · ${App.teamName}` : '')),
      tabs, body)
    if (tab === 'recentes') recentTab(body)
    else if (tab === 'grafo') g.GraphTab.render(body)
    else if (tab === 'resumo') g.BriefTab.render(body)
    else if (tab === 'atividade') g.ActivityTab.render(body)
    else g.TeamTab.render(body, { admin: Session.me && Session.me.role === 'admin' && !Session.viewAs })
  }

  g.MemoriesScreen = { render, reset() { state.loaded = false; state.entries = []; state.selected.clear(); state.selectMode = false } }
})(typeof globalThis !== 'undefined' ? globalThis : window)
