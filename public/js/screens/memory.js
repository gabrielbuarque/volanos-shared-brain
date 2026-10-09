/**
 * Uma memória, do jeito que a interface anterior tratava: cartão, leitura com o que o cérebro sabe dela,
 * anexar, editar (com tags), esquecer, compartilhar ou tornar privada, e as conexões.
 * Usado pela lista de Memórias, pelo grafo, pelo resumo e pelos itens desatualizados.
 *
 * Permissão não muda aqui: todas as chamadas passam pelo servidor, que filtra por nível, workspace e autoria.
 * `can_edit === false` desabilita as ações, como antes, para a pessoa não digitar e só então levar um 403.
 */
;(function (g) {
  const { h, mount, Button, Card, Tag, LevelPill } = g.VUI
  const { Parts, App, Session, Fmt, Legacy } = g

  function tagsOf(entry) {
    if (Array.isArray(entry.tags)) return entry.tags
    try { return JSON.parse(entry.tags || '[]') } catch (e) { return [] }
  }

  const isShared = (entry) => entry.workspace === 'company'
  const when = (ms) => formatDateUI(ms, { year: 'numeric', month: 'short', day: 'numeric' })

  /** Marca de camada: só aparece em equipe, só no que é compartilhado. Estado por texto, não por cor. */
  function layerTag(entry) {
    if (!App.team || !isShared(entry)) return null
    return Tag({ variant: 'outline', class: 'mem-layer' }, entry.actor_name ? `${t('mem.shared')} · ${entry.actor_name}` : t('mem.shared'))
  }

  /* ---------- Ações ---------- */

  function appendDialog(entry, done) {
    const field = g.VUI.Input({ multiline: true, rows: 5, label: t('mem.appendLabel'), placeholder: t('mem.appendPlaceholder'), 'data-autofocus': '' })
    const err = h('div', { 'aria-live': 'polite' })
    const save = Button({ onClick: async () => {
      const addition = field.control.value.trim()
      if (!addition) { field.setError(t('mem.appendEmpty')); return }
      save.disabled = true
      try {
        await Session.api('/append', { method: 'POST', body: { id: entry.id, addition } })
        d.close()
        g.VUI.toast(t('mem.appended'))
        done && done()
      } catch (e) { save.disabled = false; mount(err, Parts.ErrorState({})) }
    } }, t('mem.appendSave'))
    field.control.addEventListener('input', () => field.clearError())
    const d = g.VUI.openDialog({ title: t('mem.appendTitle') }, h('p', { class: 'v-caption' }, Legacy.titleLine(entry.content, 90)), field, err, h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), save))
  }

  /**
   * Editar. Memória privada (ou de quem a escreveu) passa por /update e pode trocar as tags.
   * Documento compartilhado passa pela proposta de edição: o texto novo vai à revisão e as quebras de linha ficam.
   */
  function editDialog(entry, done) {
    if (isShared(entry)) return g.EditDocDialog ? g.EditDocDialog.open(entry, done) : null
    const tags = Legacy.humanTags(tagsOf(entry))
    let keep = [...tags]
    const field = g.VUI.Input({ multiline: true, rows: 10, label: t('mem.editText'), value: entry.content, hint: t('mem.editHint'), 'data-autofocus': '' })
    const chips = h('div', { class: 'mem-tagedit' })
    const paint = () => mount(chips, keep.map((tg) => Tag({ variant: 'outline', onRemove: () => { keep = keep.filter((x) => x !== tg); paint() }, removeLabel: t('mem.removeTag', { tag: tg }) }, tg)))
    paint()
    const err = h('div', { 'aria-live': 'polite' })
    const save = Button({ onClick: async () => {
      const content = field.control.value.trim()
      if (!content) { field.setError(t('mem.editEmpty')); return }
      save.disabled = true
      try {
        await Session.api('/update', { method: 'POST', body: { id: entry.id, content, tags: keep } })
        d.close()
        g.VUI.toast(t('mem.saved'))
        done && done()
      } catch (e) { save.disabled = false; mount(err, Parts.ErrorState({})) }
    } }, t('common.save'))
    field.control.addEventListener('input', () => field.clearError())
    const d = g.VUI.openDialog({ title: t('mem.editTitle') }, field, tags.length ? [h('p', { class: 'v-caption' }, t('mem.tagsHint')), chips] : null, err, h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), save))
  }

  function forgetDialog(entry, done) {
    const d = g.VUI.openDialog({ title: t('mem.forgetTitle') }, h('p', null, t('mem.forgetBody')),
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), Button({ onClick: async (e) => {
        e.currentTarget.disabled = true
        try { await Session.api('/forget', { method: 'POST', body: { id: entry.id } }); d.close(); g.VUI.toast(t('mem.forgotten')); done && done() } catch (err) { e.currentTarget.disabled = false; g.VUI.toast(t('error.body'), { title: t('error.title') }) }
      } }, t('mem.forget'))))
  }

  /** Mover entre privado e compartilhado. Reversível em um toque: o aviso oferece desfazer. */
  async function toggleLayer(entry, done) {
    const goingShared = !isShared(entry)
    const target = goingShared ? 'company' : 'personal'
    try {
      await Session.api('/share', { method: 'POST', body: { id: entry.id, workspace: target } })
    } catch (e) { g.VUI.toast(t('mem.shareFailed')); return }
    g.VUI.toast(goingShared ? t('mem.sharedToast') : t('mem.unsharedToast'), {
      action: t('mem.undo'),
      onAction: async () => {
        try { await Session.api('/share', { method: 'POST', body: { id: entry.id, workspace: goingShared ? 'personal' : 'company' } }) } catch (e) { g.VUI.toast(t('mem.shareFailed')); return }
        done && done()
      },
    })
    done && done()
  }

  /* ---------- Leitura ---------- */

  const kindLabel = { semantic: 'mem.kindFact', episodic: 'mem.kindEvent' }
  const statusLabel = { canonical: 'mem.statusTrusted', draft: 'mem.statusUnconfirmed', deprecated: 'mem.statusSuperseded' }
  const lifeLabel = { durable: 'mem.volDurable', state: 'mem.volCurrent', volatile: 'mem.volShortLived' }
  const tagValue = (tags, prefix) => { const hit = tags.find((x) => String(x).toLowerCase().startsWith(prefix)); return hit ? String(hit).slice(prefix.length).toLowerCase() : null }

  const EVENT_KEYS = { created: 'mem.evCreated', updated: 'mem.evUpdated', appended: 'mem.evAppended', deleted: 'mem.evDeleted', status_changed: 'mem.evStatusChanged', shared: 'mem.evShared', unshared: 'mem.evUnshared', edited: 'mem.evUpdated', restored: 'mem.evRestored' }

  function brainRows(entry) {
    const tags = entry.tags || []
    const rows = []
    const row = (label, value) => rows.push(h('div', { class: 'mem-brain__row' }, h('span', null, label), h('strong', null, value)))
    if (typeof entry.importance_score === 'number') row(t('mem.importance'), `${Math.max(0, Math.min(5, Math.round(entry.importance_score)))} / 5`)
    const kind = tagValue(tags, 'kind:'), status = tagValue(tags, 'status:'), vol = tagValue(tags, 'volatility:')
    if (kind) row(t('mem.kind'), kindLabel[kind] ? t(kindLabel[kind]) : kind)
    if (status) row(t('mem.status'), statusLabel[status] ? t(statusLabel[status]) : status)
    if (vol && lifeLabel[vol]) row(t('mem.lifespan'), t(lifeLabel[vol]))
    if (typeof entry.recall_count === 'number' && entry.recall_count > 0) row(t('mem.recalled'), tPlural('mem.recalledTimes', entry.recall_count))
    const losses = Number(entry.contradiction_losses) || 0
    const notes = []
    if (losses > 0) notes.push(tPlural('mem.disagreed', losses))
    if (entry.indexed === false) notes.push(t('mem.notIndexed'))
    return rows.length || notes.length ? h('section', { class: 'mem-brain' }, h('div', { class: 'v-eyebrow' }, t('mem.brainLabel')), rows, notes.map((n) => h('p', { class: 'v-caption' }, n))) : null
  }

  function timeline(entry) {
    const items = entry.timeline || []
    const lines = []
    if (isShared(entry) && entry.actor_name) lines.push(h('p', { class: 'mem-time__row' }, t('mem.authorLabel', { name: entry.actor_name })))
    for (const it of items) {
      const label = EVENT_KEYS[it.event] ? t(EVENT_KEYS[it.event]) : it.event || ''
      lines.push(h('p', { class: 'mem-time__row' }, [Parts.authorName(it.actor_name), label, it.created_at ? formatDateUI(it.created_at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')))
    }
    if (entry.can_edit === false && entry.actor_name) lines.push(h('p', { class: 'v-caption' }, t('mem.authorLocked', { name: entry.actor_name })))
    return lines.length ? h('section', { class: 'mem-time' }, h('div', { class: 'v-eyebrow' }, t('mem.timelineLabel')), lines) : null
  }

  async function related(entry, box, reload) {
    try {
      const data = await Session.api('/connections?id=' + encodeURIComponent(entry.id))
      const list = data.connections || []
      if (!list.length) { box.hidden = true; return }
      box.hidden = false
      mount(box, h('div', { class: 'v-eyebrow' }, t('mem.related')), list.map((c) => h('div', { class: 'mem-rel' },
        h('button', { type: 'button', class: 'mem-rel__open', onClick: () => open({ id: c.id, content: c.content || c.label || '', tags: c.tags || [] }) }, Legacy.titleLine(c.content || c.label || '', 80)),
        c.provenance === 'explicit' ? Button({ variant: 'ghost', size: 'sm', onClick: async () => {
          try { await Session.api('/unlink', { method: 'POST', body: { source_id: entry.id, target_id: c.id, type: c.type } }); reload() } catch (e) { g.VUI.toast(t('error.body'), { title: t('error.title') }) }
        } }, t('mem.unlink')) : h('span', { class: 'v-caption' }, t('mem.autoLink')))))
    } catch (e) { box.hidden = true }
  }

  /** Leitura completa. Abre com o que a lista já tem e completa com /entry (linha do tempo, o que o cérebro sabe). */
  function open(entry, { onChanged } = {}) {
    const meta = h('p', { class: 'source__meta' })
    const brain = h('div')
    const time = h('div')
    const rel = h('div', { class: 'mem-related', hidden: true })
    const actions = h('div', { class: 'v-dialog__actions' })
    let current = entry
    let d
    const changed = () => { d && d.close(); onChanged && onChanged() }

    const paintMeta = (e) => mount(meta,
      e.clearance_level !== undefined && e.clearance_level !== null ? [LevelPill({ level: e.clearance_level, text: App.levelText(e.clearance_level), size: 'sm' }), ' '] : null,
      Fmt.sourceKindLabel(e.source), e.created_at ? [' · ', t('mem.metaCaptured', { relative: Fmt.relativeTime(e.created_at) })] : null,
      e.updated_at && e.created_at && Math.abs(e.updated_at - e.created_at) > 60000 ? [' · ', t('mem.metaEdited', { relative: Fmt.relativeTime(e.updated_at) })] : null)

    const paintActions = (e) => {
      const locked = e.can_edit === false
      const lockTitle = locked ? t('mem.locked') : undefined
      mount(actions,
        Button({ variant: 'ghost', onClick: () => d.close() }, t('common.close')),
        Button({ variant: 'secondary', disabled: locked, title: lockTitle, onClick: () => { d.close(); appendDialog(e, onChanged) } }, t('mem.append')),
        Button({ variant: 'secondary', disabled: locked, title: lockTitle, onClick: () => { d.close(); editDialog(e, onChanged) } }, t('mem.edit')),
        Button({ variant: 'ghost', disabled: locked, title: lockTitle, onClick: () => { d.close(); forgetDialog(e, onChanged) } }, t('mem.forgetThis')))
    }

    const tags = Legacy.humanTags(tagsOf(entry))
    paintMeta(entry)
    paintActions(entry)
    d = g.VUI.openDialog({ title: Legacy.titleLine(entry.content, 90), class: 'v-dialog--wide' },
      meta,
      h('div', { class: 'mem-text' }, Legacy.normalizeForDisplay(entry.content)),
      tags.length ? h('div', { class: 'source__tags' }, tags.map((tg) => Tag({ variant: 'outline' }, tg))) : null,
      brain, time, rel, actions)

    if (entry.id) {
      Session.api('/entry?id=' + encodeURIComponent(entry.id)).then(({ entry: full }) => {
        if (!d || !document.body.contains(actions)) return
        current = { ...entry, ...full }
        paintMeta(current)
        mount(brain, brainRows(current))
        mount(time, timeline(current))
        paintActions(current)
      }).catch(() => {})
      related(entry, rel, () => related(entry, rel, onChanged))
    }
    return d
  }

  /* ---------- Cartão ---------- */

  /**
   * Cartão de uma memória na lista. `selectable`: modo de seleção (equipe); `selected` e `onSelect` guardam o estado.
   * Esquecer fica atrás de "Mais": é a única ação destrutiva e pede um toque a mais, como antes.
   */
  function card(entry, { onChanged, selectable, selected, onSelect } = {}) {
    const tags = Legacy.humanTags(tagsOf(entry))
    const title = Legacy.titleLine(entry.content, 90)
    const preview = Legacy.previewAfterTitle(entry.content, title)
    const created = Number(entry.created_at) || 0
    const locked = entry.can_edit === false
    let vectorIds = []
    try { vectorIds = JSON.parse(entry.vector_ids || '[]') } catch (e) { /* sem índice legível */ }
    const notIndexed = vectorIds.length === 0 && Date.now() - created > 10 * 60000
    const lockTitle = locked ? t('mem.locked') : undefined
    const more = h('details', { class: 'matrix__more mem-more' }, h('summary', null, t('mem.more')),
      h('div', { class: 'matrix__morelist' },
        App.team ? Button({ variant: 'ghost', size: 'sm', onClick: () => toggleLayer(entry, onChanged) }, isShared(entry) ? t('mem.makePrivate') : t('mem.shareWithTeam')) : null,
        Button({ variant: 'ghost', size: 'sm', disabled: locked, title: lockTitle, onClick: () => forgetDialog(entry, onChanged) }, t('mem.forgetThis'))))
    return Card({ variant: 'outline', class: 'memcard' + (selected ? ' memcard--selected' : '') },
      selectable ? g.VUI.Checkbox({ label: t('mem.selectOne'), checked: !!selected, onChange: (e) => onSelect && onSelect(e.target.checked), class: 'memcard__check' }) : null,
      h('button', { type: 'button', class: 'memcard__open', onClick: () => open({ ...entry, tags: tagsOf(entry) }, { onChanged }) },
        h('span', { class: 'memcard__title' }, title),
        preview ? h('span', { class: 'memcard__preview' }, preview.length > 220 ? preview.slice(0, 220).trimEnd() + '…' : preview) : null),
      h('div', { class: 'source__meta' }, Fmt.sourceKindLabel(entry.source), created ? [' · ', h('time', { datetime: new Date(created).toISOString(), title: formatDateUI(created) }, Fmt.relativeTime(created))] : null),
      h('div', { class: 'source__tags' },
        entry.clearance_level !== undefined && entry.clearance_level !== null ? LevelPill({ level: entry.clearance_level, text: App.levelText(entry.clearance_level), size: 'sm' }) : null,
        layerTag(entry),
        tags.slice(0, 6).map((tg) => Tag({ variant: 'outline' }, tg)),
        notIndexed ? Tag({ variant: 'neutral' }, t('mem.notIndexedChip')) : null),
      h('div', { class: 'state__actions' },
        Button({ variant: 'secondary', size: 'sm', disabled: locked, title: lockTitle, onClick: () => appendDialog(entry, onChanged) }, t('mem.append')),
        Button({ variant: 'secondary', size: 'sm', disabled: locked, title: lockTitle, onClick: () => editDialog({ ...entry, tags: tagsOf(entry) }, onChanged) }, t('mem.edit')),
        more))
  }

  g.MemoryUI = { card, open, appendDialog, editDialog, forgetDialog, toggleLayer, tagsOf, isShared }
})(typeof globalThis !== 'undefined' ? globalThis : window)
