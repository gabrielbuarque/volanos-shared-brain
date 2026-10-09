/**
 * Resumo: o resumo do dia, os padrões que o cérebro percebeu (confirmar ou descartar, um a um ou em lote) e os itens
 * desatualizados (manter, editar, anexar ou esquecer). Tudo vem das rotas que a interface anterior já usava
 * (/brief, /patterns, /patterns/resolve, /stale, /stale/keep).
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Tag, Checkbox } = g.VUI
  const { Parts, App, Session, Fmt, Legacy } = g
  const PAGE = 50

  const SHAPES = ['contradiction', 'throughline', 'connection']
  const shapeLabel = (s) => (SHAPES.includes(s) ? t('patterns.shape.' + s) : '')

  /* ---------- Painéis ---------- */

  function activityPanel(activity) {
    if (!activity || !activity.length) return null
    const peak = Math.max(...activity.map((d) => d.count), 1)
    return h('section', { class: 'brief__panel' }, Eyebrow({}, t('brief.lastDays', { n: activity.length })),
      h('div', { class: 'spark', role: 'img', 'aria-label': t('brief.sparkLabel', { total: activity.reduce((n, d) => n + d.count, 0), days: activity.length }) },
        activity.map((d) => h('span', { class: 'spark__bar' + (d.count ? '' : ' spark__bar--empty'), style: { height: `${Math.max(Math.round((d.count / peak) * 100), 4)}%` }, title: tPlural('brief.activityTitle', d.count, { date: formatDateUI(d.day * 86400000, { month: 'short', day: 'numeric' }) }) }))))
  }

  function sourcesPanel(sources) {
    if (!sources || !sources.length) return null
    const total = sources.reduce((n, s) => n + s.count, 0) || 1
    return h('section', { class: 'brief__panel' }, Eyebrow({}, t('brief.whereFrom')),
      sources.slice(0, 4).map((s) => h('div', { class: 'srcrow' }, h('span', null, Fmt.sourceKindLabel(s.source)), h('span', { class: 'srcrow__bar' }, h('span', { class: 'srcrow__fill', style: { width: `${Math.round((s.count / total) * 100)}%` } })), h('span', { class: 'v-caption' }, String(s.count)))))
  }

  /* ---------- Padrões ---------- */

  async function resolvePatterns(ids, action) {
    await Session.api('/patterns/resolve', { method: 'POST', body: ids.length === 1 ? { id: ids[0], action } : { ids, action } })
  }

  function patternCard(p, onDone) {
    const { text, shape } = Legacy.splitInsightShape(p.content)
    const card = Card({ variant: 'outline', class: 'brief__card' })
    const run = async (action, btn) => {
      card.querySelectorAll('button').forEach((b) => { b.disabled = true })
      try {
        await resolvePatterns([p.id], action)
        mount(card, h('p', { class: 'v-caption' }, t(action === 'confirm' ? 'brief.confirmed' : 'brief.dismissed')))
        onDone && onDone()
      } catch (e) {
        card.querySelectorAll('button').forEach((b) => { b.disabled = false })
        g.VUI.toast(t('brief.failedRetry'))
      }
    }
    mount(card, Eyebrow({}, shape ? `${t('brief.patternNoticed')} · ${shapeLabel(shape)}` : t('brief.patternNoticed')), h('p', null, text),
      h('div', { class: 'state__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: (e) => run('confirm', e.currentTarget) }, t('brief.confirm')), Button({ variant: 'ghost', size: 'sm', onClick: (e) => run('dismiss', e.currentTarget) }, t('brief.dismiss'))))
    return card
  }

  /** Fila completa de padrões, com seleção em lote e "mostrar mais". */
  function patternQueue(host, onChange) {
    const st = { rows: [], total: 0, picked: new Set() }
    const list = h('div', { class: 'brief__queue' })
    const bar = h('div', { class: 'mem-bulk' })
    const more = Button({ variant: 'secondary', size: 'sm', hidden: true, onClick: () => load(true) }, t('patterns.moreBtn'))
    mount(host, h('p', { class: 'v-caption' }, t('patterns.intro')), bar, list, more)
    function paint() {
      if (!st.rows.length) { mount(bar); mount(list, Parts.EmptyState({ title: t('patterns.emptyTitle'), body: t('patterns.emptyBody') })); more.hidden = true; return }
      const n = st.picked.size
      mount(bar,
        Checkbox({ label: n ? tPlural('patterns.nSelected', n, { n }) : t('patterns.selectAll'), checked: n > 0 && n === st.rows.length, onChange: (e) => { st.picked = e.target.checked ? new Set(st.rows.map((r) => r.id)) : new Set(); paint() } }),
        Button({ variant: 'secondary', size: 'sm', disabled: !n, onClick: () => bulk('confirm') }, n > 1 ? tPlural('patterns.confirmN', n, { n }) : t('brief.confirm')),
        Button({ variant: 'ghost', size: 'sm', disabled: !n, onClick: () => bulk('dismiss') }, n > 1 ? tPlural('patterns.dismissN', n, { n }) : t('brief.dismiss')))
      mount(list, st.rows.map((p) => {
        const { text, shape } = Legacy.splitInsightShape(p.content)
        const meta = [shapeLabel(shape), p.created_at ? t('patterns.noticedWhen', { date: formatDateUI(p.created_at, { year: 'numeric', month: 'short', day: 'numeric' }) }) : ''].filter(Boolean).join(' · ')
        return Card({ variant: 'outline', class: 'brief__card' },
          Checkbox({ label: text, checked: st.picked.has(p.id), onChange: (e) => { e.target.checked ? st.picked.add(p.id) : st.picked.delete(p.id); paint() } }),
          meta ? h('p', { class: 'source__meta' }, meta) : null,
          (p.sources || []).length ? h('ul', { class: 'brief__sources' }, p.sources.map((s) => h('li', null, s.missing ? t('patterns.sourceGone') : (s.content || '').slice(0, 160)))) : null)
      }))
      const remaining = st.total - st.rows.length
      more.hidden = remaining <= 0
      if (remaining > 0) more.textContent = t('patterns.more', { n: remaining })
    }
    async function bulk(action) {
      const ids = [...st.picked]
      if (!ids.length) return
      try {
        await resolvePatterns(ids, action)
        const gone = new Set(ids)
        st.rows = st.rows.filter((r) => !gone.has(r.id)); st.total = Math.max(0, st.total - ids.length); st.picked = new Set()
        paint()
        onChange && onChange()
        if (!st.rows.length && st.total > 0) load(false)
      } catch (e) { g.VUI.toast(t('patterns.failed')) }
    }
    async function load(append) {
      if (!append) mount(list, Parts.Skeleton({ lines: 3 }))
      try {
        const d = await Session.api(`/patterns?limit=${PAGE}&offset=${append ? st.rows.length : 0}`)
        st.total = d.total
        st.rows = append ? [...st.rows, ...d.patterns] : d.patterns
        paint()
      } catch (e) { if (!append) mount(list, Parts.ErrorState({ onRetry: () => load(false) })) }
    }
    load(false)
  }

  /* ---------- Itens desatualizados ---------- */

  function staleQueue(host, onChange) {
    const st = { rows: [], total: 0 }
    const list = h('div', { class: 'brief__queue' })
    const more = Button({ variant: 'secondary', size: 'sm', hidden: true, onClick: () => load(true) }, t('stale.moreBtn'))
    mount(host, h('p', { class: 'v-caption' }, t('stale.intro')), list, more)
    const refresh = () => { onChange && onChange(); load(false) }
    function paint() {
      if (!st.rows.length) { mount(list, Parts.EmptyState({ title: t('stale.emptyTitle'), body: t('stale.empty') })); more.hidden = true; return }
      mount(list, st.rows.map((e) => {
        const confirmed = e.last_updated || e.created_at
        const locked = e.can_edit === false
        return Card({ variant: 'outline', class: 'brief__card' },
          h('p', null, e.content),
          confirmed ? h('p', { class: 'source__meta' }, t('stale.lastConfirmed', { date: formatDateUI(confirmed, { year: 'numeric', month: 'short', day: 'numeric' }) })) : null,
          h('div', { class: 'state__actions' },
            Button({ variant: 'secondary', size: 'sm', onClick: async (ev) => { ev.currentTarget.disabled = true; try { await Session.api('/stale/keep', { method: 'POST', body: { id: e.id } }); refresh() } catch (err) { ev.currentTarget.disabled = false; g.VUI.toast(t('stale.keepFailed')) } } }, t('stale.keep')),
            Button({ variant: 'ghost', size: 'sm', disabled: locked, onClick: () => g.MemoryUI.editDialog({ ...e, tags: g.MemoryUI.tagsOf(e) }, refresh) }, t('mem.edit')),
            Button({ variant: 'ghost', size: 'sm', disabled: locked, onClick: () => g.MemoryUI.appendDialog(e, refresh) }, t('mem.append')),
            Button({ variant: 'ghost', size: 'sm', disabled: locked, onClick: () => g.MemoryUI.forgetDialog(e, refresh) }, t('mem.forgetThis'))))
      }))
      const remaining = st.total - st.rows.length
      more.hidden = remaining <= 0
      if (remaining > 0) more.textContent = t('stale.more', { n: remaining })
    }
    async function load(append) {
      if (!append) mount(list, Parts.Skeleton({ lines: 3 }))
      try {
        const d = await Session.api(`/stale?limit=${PAGE}&offset=${append ? st.rows.length : 0}`)
        st.total = d.total
        st.rows = append ? [...st.rows, ...d.entries] : d.entries
        paint()
      } catch (e) { if (!append) mount(list, Parts.ErrorState({ onRetry: () => load(false) })) }
    }
    load(false)
  }

  /* ---------- Aba ---------- */

  async function render(host) {
    const top = h('div', { class: 'brief' })
    const patternsBox = h('div')
    const staleBox = h('div')
    mount(host, top, h('section', { class: 'admin__section' }, Eyebrow({}, t('patterns.title')), patternsBox), h('section', { class: 'admin__section' }, Eyebrow({}, t('stale.title')), staleBox))
    mount(top, Parts.Skeleton({ lines: 3 }))
    patternQueue(patternsBox, () => {})
    staleQueue(staleBox, () => {})
    try {
      const data = await Session.api('/brief')
      App.count = data.total || App.count
      const att = data.attention || {}
      const panels = [activityPanel(data.activity), sourcesPanel(data.sources)].filter(Boolean)
      const topics = (data.topics || []).filter((x) => !Legacy.isSystemTag(x.tag)).slice(0, 6)
      mount(top,
        att.unindexed > 0 || att.stale > 0 ? h('p', { class: 'turn__note' }, [att.unindexed > 0 ? tPlural('brief.attentionUnindexed', att.unindexed, { n: att.unindexed }) : '', att.stale > 0 ? tPlural('brief.attentionStale', att.stale, { n: att.stale }) : ''].filter(Boolean).join(' · ')) : null,
        panels.length ? h('div', { class: 'brief__grid' }, panels) : null,
        topics.length ? h('div', { class: 'ask__shortcuts', role: 'group', 'aria-label': t('brief.topics') }, topics.map((x) => Tag({ variant: 'outline', onClick: () => { g.AskScreen.prefill(t('brief.askAbout', { tag: x.tag })); window.location.hash = '#/perguntar' } }, `${x.tag} · ${x.count}`))) : null,
        data.resurface ? Card({ variant: 'outline', class: 'brief__card' }, Eyebrow({}, data.resurface.created_at ? `${t('brief.worthRereading')} · ${t('brief.fromDate', { date: formatDateUI(data.resurface.created_at, { year: 'numeric', month: 'short', day: 'numeric' }) })}` : t('brief.worthRereading')), h('p', null, Legacy.titleLine(data.resurface.content, 180))) : null,
        !panels.length && !topics.length && !data.resurface && !(att.unindexed > 0 || att.stale > 0) ? Parts.EmptyState({ title: t('brief.emptyTitle'), body: t('brief.emptyBody') }) : null)
    } catch (e) { mount(top, Parts.ErrorState({ onRetry: () => render(host) })) }
  }

  g.BriefTab = { render, patternCard }
})(typeof globalThis !== 'undefined' ? globalThis : window)
