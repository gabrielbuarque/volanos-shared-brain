/**
 * Dados e manutenção, como a interface anterior tinha no menu: backup em JSON, exportar em Markdown, restaurar de um
 * backup, resumos por tag (digest), indexar o que falta e classificar o que falta. Exportar e restaurar são de quem está
 * logado (o servidor filtra por nível e workspace); manutenção é só admin (/stats exige admin).
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow } = g.VUI
  const { Parts, App, Session, Legacy } = g

  const nf = (n) => Number(n).toLocaleString(localeTag())

  /* ---------- Exportar ---------- */

  async function exportMemories(format) {
    try {
      const data = await Session.api('/export')
      const entries = data.entries || []
      const edges = data.edges || []
      const ts = new Date().toISOString().slice(0, 10)
      if (format === 'json') {
        Legacy.downloadTextFile(document, JSON.stringify(data, null, 2), `shared-brain-backup-${ts}.json`, 'application/json')
        return
      }
      const lines = [t('data.mdTitle'), t('data.mdExported', { date: ts }), '']
      entries.forEach((e, i) => {
        lines.push(t('data.mdMemory', { n: i + 1 }))
        lines.push(t('data.mdDate', { date: formatDateUI(e.created_at, { year: 'numeric', month: 'short', day: 'numeric' }) }))
        if ((e.tags || []).length) lines.push(t('data.mdTags', { tags: e.tags.join(', ') }))
        if (e.source) lines.push(t('data.mdSource', { source: e.source }))
        lines.push('', e.content, '', '---', '')
      })
      if (edges.length) {
        const label = new Map(entries.map((e) => [e.id, (e.content || '').slice(0, 60)]))
        lines.push(t('data.mdRelations'), '')
        edges.forEach((e) => lines.push(`- [${e.type}] ${label.get(e.source_id) || e.source_id} -> ${label.get(e.target_id) || e.target_id} (${e.weight})`))
        lines.push('')
      }
      Legacy.downloadTextFile(document, lines.join('\n'), `shared-brain-export-${ts}.md`, 'text/markdown')
    } catch (e) { g.VUI.toast(t('data.exportFailed')) }
  }

  /* ---------- Restaurar ---------- */

  async function importLoop(payload, post, onProgress) {
    const totals = { imported: 0, skipped: 0, failed: 0, edges_imported: 0, edges_failed: 0 }
    let offset = 0
    let edgeOffset = 0
    const total = (payload.entries || []).length + (payload.edges || []).length
    for (;;) {
      const d = await post(`offset=${offset}&edge_offset=${edgeOffset}`)
      totals.imported += d.imported || 0; totals.skipped += d.skipped || 0; totals.failed += d.failed || 0
      totals.edges_imported += d.edges_imported || 0; totals.edges_failed += d.edges_failed || 0
      const next = d.next_offset ?? offset
      const nextEdge = d.next_edge_offset ?? edgeOffset
      const stalled = next === offset && nextEdge === edgeOffset
      offset = next; edgeOffset = nextEdge
      onProgress(Math.min(offset + edgeOffset, total), total)
      if ((d.remaining_entries || 0) === 0 && (d.remaining_edges || 0) === 0) return totals
      if (stalled) throw new Error('stalled')
    }
  }

  function pickFile() {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: '.json,application/json', onChange: () => resolve(input.files && input.files[0] ? input.files[0] : null) })
      input.click()
    })
  }

  async function indexPending(onStep) {
    let remaining = 1
    let done = 0
    while (remaining > 0) {
      const d = await Session.api('/vectorize-pending', { method: 'POST' })
      remaining = d.remaining ?? 0
      done += d.processed ?? 0
      onStep && onStep(done, remaining)
      if ((d.processed ?? 0) === 0 && remaining > 0) break
    }
    return { done, remaining }
  }

  /** Restaurar de um backup (JSON). Mostra o andamento num diálogo e termina oferecendo indexar o que entrou. */
  async function restoreFromBackup() {
    const file = await pickFile()
    if (!file) return
    let payload
    try { payload = JSON.parse(await file.text()) } catch (e) { g.VUI.toast(t('data.restoreInvalid', { name: file.name })); return }
    if (!payload || !Array.isArray(payload.entries)) { g.VUI.toast(t('data.restoreNotBackup', { name: file.name })); return }
    const status = h('p', { role: 'status', 'aria-live': 'polite' }, t('data.restoreStart', { name: file.name }))
    const actions = h('div', { class: 'v-dialog__actions' })
    const d = g.VUI.openDialog({ title: t('data.restoreTitle'), dismissible: false }, status, actions)
    try {
      const totals = await importLoop(payload, async (q) => Session.api(`/import?${q}`, { method: 'POST', body: payload }), (done, total) => { status.textContent = t('data.restoreOf', { done: nf(done), total: nf(total) }) })
      const parts = [t('data.restoredN', { n: nf(totals.imported) })]
      if (totals.edges_imported) parts.push(t('data.restoredEdges', { n: nf(totals.edges_imported) }))
      if (totals.skipped) parts.push(t('data.restoredPresent', { n: nf(totals.skipped) }))
      const failed = totals.failed + totals.edges_failed
      status.textContent = parts.join(' · ') + '.' + (failed ? ' ' + t('data.restoreFailNote', { n: nf(failed) }) : '') + (totals.imported ? ' ' + t('data.restoreNeedsIndex') : '')
      if (g.MemoriesScreen) g.MemoriesScreen.reset()
      mount(actions, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.close')), totals.imported ? Button({ onClick: async (e) => {
        e.currentTarget.disabled = true
        try { const r = await indexPending((done, remaining) => { status.textContent = t('data.indexing', { done: nf(done), remaining: nf(remaining) }) }); status.textContent = r.remaining ? t('data.indexQuotaLeft', { n: nf(r.remaining) }) : t('data.indexDone') } catch (err) { status.textContent = t('data.indexFailed') }
      } }, t('data.makeSearchable')) : null)
    } catch (e) {
      status.textContent = t('data.restoreStopped')
      mount(actions, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.close')))
    }
  }

  /* ---------- Manutenção (admin) ---------- */

  function task(label, note, action, runLabel) {
    const out = h('p', { class: 'v-caption', role: 'status', 'aria-live': 'polite' })
    const btn = Button({ variant: 'secondary', size: 'sm', onClick: async () => {
      btn.disabled = true
      out.textContent = t('data.working')
      try { out.textContent = await action((msg) => { out.textContent = msg }) } catch (e) { out.textContent = t('data.requestFailed'); btn.disabled = false }
    } }, runLabel)
    return h('div', { class: 'upkeep__task' }, h('strong', null, label), h('p', { class: 'v-caption' }, note), btn, out)
  }

  async function upkeep(host) {
    mount(host, Parts.Skeleton({ lines: 3 }))
    let stats
    try { stats = await Session.api('/stats') } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => upkeep(host) })); return }
    const tasks = []
    const candidates = stats.digest_candidates || []
    for (const c of candidates.slice(0, 6)) {
      tasks.push(task(c.tag, tPlural('data.digestEntries', c.count, { n: c.count }), async () => {
        const d = await Session.api('/digest?tag=' + encodeURIComponent(c.tag))
        return d.synthesis ? `${c.tag}: ${d.synthesis}` : d.error || t('data.digestFailed')
      }, t('data.digestAction')))
    }
    if (stats.unvectorized) tasks.push(task(t('data.vectorizeLabel'), tPlural('data.vectorizeNote', stats.unvectorized, { n: nf(stats.unvectorized) }), async (say) => { const r = await indexPending((done) => say(t('data.vectorizeDone', { n: nf(done) }))); return t('data.vectorizeDone', { n: nf(r.done) }) }, t('data.vectorizeAction')))
    if (stats.unclassified) tasks.push(task(t('data.classifyLabel'), tPlural('data.classifyNote', stats.unclassified, { n: nf(stats.unclassified) }), async (say) => {
      let remaining = 1, prev = Infinity, total = 0
      while (remaining > 0) {
        const d = await Session.api('/classify-pending', { method: 'POST' })
        remaining = d.remaining ?? 0; total += d.processed ?? 0
        say(t('data.classifyDone', { n: nf(total) }))
        if (remaining >= prev) break
        prev = remaining
      }
      return t('data.classifyDone', { n: nf(total) })
    }, t('data.classifyAction')))
    mount(host, tasks.length ? h('div', { class: 'upkeep' }, tasks) : h('p', { class: 'v-caption' }, t('data.upkeepNone')))
  }

  /** Bloco de dados para quem está logado: backup, Markdown e restaurar. */
  function dataButtons() {
    return h('div', { class: 'state__actions' },
      Button({ variant: 'secondary', size: 'sm', onClick: () => exportMemories('json') }, t('data.backupJson')),
      Button({ variant: 'secondary', size: 'sm', onClick: () => exportMemories('markdown') }, t('data.exportMarkdown')),
      Button({ variant: 'secondary', size: 'sm', onClick: restoreFromBackup }, t('data.restore')))
  }

  g.DataTools = { exportMemories, restoreFromBackup, upkeep, dataButtons }
})(typeof globalThis !== 'undefined' ? globalThis : window)
