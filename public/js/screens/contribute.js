/**
 * Contribuir: solte um arquivo ou cole uma transcrição; a IA sugere cliente, nível P e resumo; a pessoa
 * confirma ou corrige em um passo; o item entra na fila do owner do cliente. A segunda aba é a fila de revisão:
 * aprovar, ajustar o nível ou recusar com motivo.
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Input, Select, Tabs, LevelPill } = g.VUI
  const { Parts, App, Session } = g
  const MAX_CHARS = 60000
  const ACCEPT = '.md,.txt,.csv,.json,.vtt,.srt,text/plain,text/markdown'

  const clientOptions = () => [...App.clients.map((c) => ({ value: c.id, label: c.name })), { value: App.INTERNAL, label: t('client.internal') }]
  const levelOptions = () => Array.from({ length: 13 }, (_, n) => ({ value: String(n), label: `P${n} · ${(App.levels[n] && App.levels[n].holders) || ''}` }))

  function titleFromName(name) {
    return String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim()
  }

  /* ---------- Enviar ---------- */

  function sendPanel(onSent) {
    const panel = h('div', { class: 'contribute__send' })
    const state = { text: '', filename: '' }

    function step1() {
      const area = Input({ multiline: true, rows: 8, label: t('contribute.pasteLabel'), placeholder: t('contribute.pastePlaceholder'), hint: t('contribute.limit', { max: MAX_CHARS.toLocaleString(localeTag()) }) })
      area.control.value = state.text
      const fileInput = h('input', { type: 'file', accept: ACCEPT, class: 'v-sr-only', id: 'contribute-file', onChange: (e) => readFile(e.target.files[0]) })
      const drop = h('label', { class: 'dropzone', for: 'contribute-file', tabindex: '0', onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click() } } },
        h('strong', null, t('contribute.dropTitle')), h('span', { class: 'v-caption' }, t('contribute.dropHint')), fileInput)
      ;['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over') }))
      ;['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over') }))
      drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]))
      const err = h('div', { 'aria-live': 'polite' })
      async function readFile(file) {
        if (!file) return
        if (file.size > MAX_CHARS * 4) { mount(err, h('p', { class: 'form-error', role: 'alert' }, t('contribute.tooBig'))); return }
        state.filename = file.name
        area.control.value = await file.text()
        mount(err, h('p', { class: 'v-caption' }, t('contribute.loadedFile', { name: file.name })))
      }
      const go = Button({ iconAfter: 'arrow-right', onClick: async () => {
        const text = area.control.value.trim()
        if (!text) { mount(err, h('p', { class: 'form-error', role: 'alert' }, t('contribute.empty'))); return }
        if (text.length > MAX_CHARS) { mount(err, h('p', { class: 'form-error', role: 'alert' }, t('contribute.tooLong', { max: MAX_CHARS.toLocaleString(localeTag()) }))); return }
        state.text = text
        go.disabled = true
        mount(err, h('p', { class: 'v-caption', role: 'status' }, t('contribute.analyzing')))
        try {
          const s = await Session.api('/contributions/suggest', { method: 'POST', body: { content: text, filename: state.filename } })
          step2(s)
        } catch (e) {
          go.disabled = false
          mount(err, Parts.ErrorState({}))
        }
      } }, t('contribute.analyze'))
      mount(panel, drop, area, err, go)
    }

    function step2(s) {
      const client = Select({ label: t('contribute.client'), options: clientOptions(), value: s.client })
      const level = Select({ label: t('contribute.level'), options: levelOptions(), value: String(s.level), hint: t('contribute.levelHint') })
      const summary = Input({ label: t('contribute.summary'), value: s.summary || '' })
      const err = h('div', { 'aria-live': 'polite' })
      const submit = Button({ onClick: async () => {
        submit.disabled = true
        const title = titleFromName(state.filename)
        const content = /^#\s/.test(state.text) || !title ? state.text : `# ${title}\n\n${state.text}`
        try {
          const r = await Session.api('/contributions/submit', { method: 'POST', body: { content, filename: state.filename, client: client.control.value, level: Number(level.control.value), summary: summary.control.value } })
          g.VUI.toast(r.owner && r.owner.name ? t('contribute.sent', { owner: r.owner.name }) : t('contribute.sentPlain'), { title: t('contribute.sentTitle') })
          state.text = ''
          state.filename = ''
          step1()
          onSent()
        } catch (e) {
          submit.disabled = false
          mount(err, Parts.ErrorState({}))
        }
      } }, t('contribute.submit'))
      mount(panel,
        h('p', { class: 'v-caption' }, s.source === 'ai' ? t('contribute.suggestedByAi') : t('contribute.suggestedByRules')),
        client, level, summary,
        h('details', { class: 'source__details' }, h('summary', null, t('contribute.preview')), h('div', { class: 'source__body' }, state.text.slice(0, 1500))),
        err,
        h('div', { class: 'state__actions' }, Button({ variant: 'ghost', onClick: step1 }, t('common.back')), submit))
    }

    step1()
    return panel
  }

  async function mineList(host) {
    try {
      const { contributions } = await Session.api('/contributions/mine')
      if (!contributions.length) { mount(host); return }
      mount(host, Eyebrow({}, t('contribute.mine')), h('ul', { class: 'minelist' }, contributions.slice(0, 10).map((c) =>
        h('li', null, h('span', null, c.source_path || t('contribute.pasted')), h('span', { class: 'v-caption' }, t('contribute.status.' + c.status))))))
    } catch (e) { mount(host) }
  }

  /* ---------- Fila de revisão ---------- */

  function reasonText(c) {
    const key = { 'canon-proposal': 'canon', 'client-contribution': 'contribution', 'above-submitter': 'above', 'low-confidence': 'low', 'ambiguous-levels': 'ambiguous', 'classifier-unavailable': 'unavailable' }[c.reason]
    return key ? t('review.reason.' + key) : ''
  }

  function rejectDialog(c, done) {
    const motive = Input({ multiline: true, rows: 3, label: t('review.motive'), hint: t('review.motiveHint'), 'data-autofocus': '' })
    const err = h('div', { 'aria-live': 'polite' })
    const d = g.VUI.openDialog({ title: t('review.rejectTitle') }, motive, err,
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), Button({ onClick: async () => {
        const text = motive.control.value.trim()
        if (!text) { motive.control.setAttribute('aria-invalid', 'true'); mount(err, h('p', { class: 'form-error', role: 'alert' }, t('review.motiveRequired'))); return }
        try {
          await Session.api('/contributions/resolve', { method: 'POST', body: { id: c.id, action: 'reject', motive: text } })
          d.close()
          g.VUI.toast(t('review.rejected'))
          done()
        } catch (e) { mount(err, Parts.ErrorState({})) }
      } }, t('review.reject'))))
  }

  function reviewCard(c, reload) {
    const floor = Session.me.clearanceFloor
    const levels = levelOptions().filter((o) => Number(o.value) >= floor)
    const level = Select({ label: t('review.level'), options: levels, value: String(Math.max(floor, c.suggested_level)) })
    const text = Input({ multiline: true, rows: 4, label: t('review.text'), value: c.content })
    const conf = c.confidence == null ? null : t('review.confidence', { pct: Math.round(c.confidence * 100) })
    return Card({ variant: 'outline', class: 'reviewcard' },
      h('div', { class: 'source__head' },
        h('h3', { class: 'source__title' }, c.client_name || t('client.internal')),
        LevelPill({ level: c.suggested_level, text: App.levelText(c.suggested_level), size: 'sm' })),
      h('p', { class: 'source__meta' }, c.submitter_name || t('common.unknownAuthor'), ' · ', formatDateUI(c.created_at), c.source_path ? [' · ', c.source_path] : null, conf ? [' · ', conf] : null),
      reasonText(c) ? h('p', { class: 'v-caption' }, reasonText(c)) : null,
      text, level,
      h('div', { class: 'state__actions' },
        Button({ variant: 'secondary', size: 'sm', onClick: async (e) => {
          e.currentTarget.disabled = true
          try {
            const r = await Session.api('/contributions/resolve', { method: 'POST', body: { id: c.id, action: 'approve', level: Number(level.control.value), content: text.control.value } })
            g.VUI.toast(t('review.published', { level: `P${r.level}` }))
            reload()
          } catch (err) { g.VUI.toast(t('error.body'), { title: t('error.title') }); e.currentTarget.disabled = false }
        } }, t('review.approve')),
        Button({ variant: 'ghost', size: 'sm', onClick: () => rejectDialog(c, reload) }, t('review.reject'))),
    )
  }

  async function reviewPanel(host) {
    mount(host, Parts.Skeleton({ lines: 3 }))
    try {
      const { contributions } = await Session.api('/contributions?status=pending')
      mount(host, contributions.length
        ? h('div', { class: 'reviewlist' }, contributions.map((c) => reviewCard(c, () => reviewPanel(host))))
        : Parts.EmptyState({ title: t('review.emptyTitle'), body: t('review.emptyBody') }))
    } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => reviewPanel(host) })) }
  }

  function render(host) {
    const body = h('div', { class: 'contribute__body' })
    const mine = h('div', { class: 'contribute__mine' })
    function show(tab) {
      if (tab === 'review') { mount(body); reviewPanel(body) }
      else { mount(body, sendPanel(() => mineList(mine)), mine); mineList(mine) }
    }
    const tabs = Tabs({ label: t('contribute.tabs'), value: 'send', items: [{ id: 'send', label: t('contribute.tabSend') }, { id: 'review', label: t('contribute.tabReview') }], onChange: show })
    mount(host, h('div', { class: 'page-head' }, Eyebrow({}, t('nav.contribute')), h('h1', null, t('contribute.title')), h('p', { class: 'v-caption' }, t('contribute.intro'))), tabs, body)
    show('send')
  }

  g.ContributeScreen = { render }
})(typeof globalThis !== 'undefined' ? globalThis : window)
