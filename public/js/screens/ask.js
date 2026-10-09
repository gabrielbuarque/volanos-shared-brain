/**
 * Perguntar: a home do app.
 *
 * Fluxo: /recall no escopo do cliente ativo (que se soma ao nível da pessoa, nunca o substitui)
 * -> /chat com as fontes numeradas -> resposta com frase direta, chips [n] e cartões de fonte.
 * Estados desenhados: carregando (com Parar), não encontrei, conflito, fonte antiga e erro.
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Statement, Tag } = g.VUI
  const { Parts, Fmt, App, Session } = g

  const NOT_FOUND = '[not-found]'
  const state = { turns: [], seq: 0, busy: null }

  function resetConversation() {
    if (state.busy) state.busy.abort()
    state.turns = []
    state.busy = null
  }

  /** Quando o cliente ativo muda, a conversa some: o escopo da busca é outro. */
  App.onClientChange(() => resetConversation())

  function modelLabel(meta) {
    if (!meta || !meta.model) return ''
    const short = String(meta.model).split('/').pop()
    return meta.fallback ? t('ask.answeredByFallback', { model: short }) : t('ask.answeredBy', { model: short })
  }

  /** Texto para o campo, a partir de um atalho. */
  function shortcutPrompt(kind) {
    return t('ask.prompt.' + kind, { client: App.clientName(App.activeClient) })
  }

  async function runTurn(turn) {
    const ctrl = new AbortController()
    state.busy = ctrl
    turn.status = 'loading'
    turn.text = ''
    repaint()
    try {
      let sources = turn.reuse
      let conflicts = turn.conflicts || []
      if (!sources) {
        const params = new URLSearchParams({ query: turn.query, topK: '6', hops: '1', full: '1' })
        params.set('client', turn.client)
        const data = await Session.api('/recall?' + params, { signal: ctrl.signal })
        sources = data.results || []
        conflicts = data.conflicts || []
      }
      turn.sources = sources
      turn.conflicts = conflicts
      if (!sources.length) {
        turn.status = 'notfound'
        return
      }
      repaint()
      const choice = g.Admin && g.Admin.modelChoice ? g.Admin.modelChoice() : null
      const res = await Session.api('/chat', {
        method: 'POST', raw: true, signal: ctrl.signal,
        body: { query: turn.instruction || turn.query, memories: Fmt.chatContext(sources), memory_ids: sources.map((s) => s.id), ...(choice ? { provider: choice.provider, model: choice.model } : {}) },
      })
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})))
      const out = await g.ChatStream.read(res, { signal: ctrl.signal, onText: (txt) => { turn.text = txt; paintStreaming(turn) } })
      turn.meta = out.meta
      turn.text = out.text.trim()
      turn.status = turn.text.startsWith(NOT_FOUND) ? 'notfound' : 'done'
      if (turn.status === 'notfound') turn.text = turn.text.slice(NOT_FOUND.length).trim()
      if (!turn.text && turn.status === 'done') turn.status = 'notfound'
    } catch (e) {
      if (e && e.name === 'AbortError') turn.status = turn.text ? 'stopped' : 'stopped-empty'
      else turn.status = 'error'
    } finally {
      if (state.busy === ctrl) state.busy = null
      repaint()
    }
  }

  function ask(query, extra = {}) {
    const q = String(query || '').trim()
    if (!q || state.busy) return
    const turn = { id: ++state.seq, query: extra.display || q, instruction: extra.instruction, client: App.activeClient, status: 'loading', text: '', sources: [], conflicts: [], reuse: extra.reuse, meta: null }
    state.turns.push(turn)
    runTurn(turn)
  }

  let host = null
  function repaint() {
    if (host && host.isConnected) draw()
    const input = host && host.querySelector('.composer__field')
    if (input) input.disabled = false
    const last = host && host.querySelector('.turn:last-child')
    if (last && last.dataset.fresh !== '1') {
      last.dataset.fresh = '1'
      last.scrollIntoView({ block: 'start' })
    }
  }

  function paintStreaming(turn) {
    const el = host && host.querySelector(`[data-turn="${turn.id}"] .answer-stream`)
    if (el) el.textContent = turn.text
  }

  function highlight(turn, n) {
    const el = host.querySelector(`#src-${turn.id}-${n}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('v-card--selected')
    el.focus({ preventScroll: true })
    const details = el.querySelector('details')
    if (details) details.open = true
    setTimeout(() => el.classList.remove('v-card--selected'), 1800)
  }

  function scopeLine(turn) {
    const types = Fmt.joinList(turn.sources.map((s) => Fmt.sourceKindLabel(s.source)))
    return tPlural('ask.scope', turn.sources.length, { client: App.clientName(turn.client), types })
  }

  async function onFlag(conflict, button) {
    button.disabled = true
    try {
      const r = await Session.api('/conflicts/flag', { method: 'POST', body: { a: conflict.a, b: conflict.b, metric: conflict.metric } })
      button.textContent = r.owner && r.owner.name ? t('conflict.flagged', { owner: r.owner.name }) : t('conflict.flaggedPlain')
      g.VUI.toast(button.textContent, { title: t('conflict.toastTitle') })
    } catch (e) {
      button.disabled = false
      g.VUI.toast(t('error.body'), { title: t('error.title') })
    }
  }

  function openClaudeDialog(turn) {
    g.ClaudeDialog.open({ clientName: App.clientName(turn.client), ids: turn.sources.map((s) => s.id), question: turn.query })
  }

  function openCanonDialog(turn) {
    const clients = [{ value: App.INTERNAL, label: t('client.internal') }, ...App.clients.map((c) => ({ value: c.id, label: c.name }))]
    const select = g.VUI.Select({ label: t('canon.client'), options: clients, value: turn.client })
    const text = g.VUI.Input({ multiline: true, rows: 7, label: t('canon.text'), value: turn.text })
    const submit = Button({ onClick: async () => {
      submit.disabled = true
      try {
        const r = await Session.api('/canon/propose', { method: 'POST', body: { content: text.control.value, client: select.control.value, source_ids: turn.sources.map((s) => s.id) } })
        d.close()
        g.VUI.toast(r.owner && r.owner.name ? t('canon.done', { owner: r.owner.name }) : t('canon.donePlain'), { title: t('canon.doneTitle') })
      } catch (e) {
        submit.disabled = false
        g.VUI.toast(t('error.body'), { title: t('error.title') })
      }
    } }, t('canon.submit'))
    const d = g.VUI.openDialog({ title: t('canon.title') }, h('p', null, t('canon.body')), select, text, h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), submit))
  }

  function turnActions(turn) {
    const draft = Button({ variant: 'secondary', size: 'sm', onClick: () => ask(t('ask.action.proposal'), { display: t('ask.action.proposal'), instruction: t('ask.prompt.draft', { client: App.clientName(turn.client) }), reuse: turn.sources }) }, t('ask.action.proposal'))
    return h('div', { class: 'turn__actions' }, draft,
      Button({ variant: 'secondary', size: 'sm', onClick: () => openClaudeDialog(turn) }, t('ask.action.claude')),
      Button({ variant: 'secondary', size: 'sm', onClick: () => openCanonDialog(turn) }, t('ask.action.canon')))
  }

  function answerBody(turn) {
    const byId = new Map(turn.sources.map((s) => [s.id, s]))
    const staleCount = turn.sources.filter((s) => s.stale).length
    const parts = []
    if (turn.status === 'loading') {
      parts.push(turn.text ? h('p', { class: 'answer-stream answer__lead', 'aria-live': 'polite' }, turn.text) : Parts.Skeleton({ lines: 3 }))
      parts.push(h('div', { class: 'turn__actions' }, Button({ variant: 'secondary', size: 'sm', icon: 'x', onClick: () => state.busy && state.busy.abort() }, t('ask.stop')), h('span', { class: 'v-caption' }, t('ask.searching', { client: App.clientName(turn.client) }))))
      return parts
    }
    if (turn.status === 'stopped-empty') return [Parts.EmptyState({ title: t('ask.stopped'), actions: [Button({ variant: 'secondary', size: 'sm', onClick: () => { state.turns = state.turns.filter((x) => x !== turn); ask(turn.query) } }, t('common.retry'))] })]
    if (turn.status === 'error') return [Parts.ErrorState({ onRetry: () => { state.turns = state.turns.filter((x) => x !== turn); ask(turn.query, { instruction: turn.instruction, reuse: turn.reuse }) } })]
    if (turn.status === 'notfound') {
      return [Parts.EmptyState({
        title: t('ask.notFound.title'),
        body: turn.text || t('ask.notFound.body', { client: App.clientName(turn.client) }),
        actions: [
          Button({ variant: 'secondary', size: 'sm', onClick: () => { const f = host.querySelector('.composer__field'); if (f) { f.value = turn.query; f.focus() } } }, t('ask.notFound.rephrase')),
          Button({ variant: 'ghost', size: 'sm', href: '#/contribuir' }, t('ask.notFound.contribute')),
        ],
        next: true,
      }), h('p', { class: 'v-caption turn__next' }, t('ask.notFound.next'))]
    }
    // done | stopped
    parts.push(Fmt.renderAnswer(turn.text, { max: turn.sources.length, onCite: (n) => highlight(turn, n) }))
    if (turn.status === 'stopped') parts.push(h('p', { class: 'v-caption' }, t('ask.stoppedPartial')))
    if (staleCount) parts.push(h('p', { class: 'turn__note' }, t('ask.staleNote', { days: Parts.STALE_DAYS })))
    for (const c of turn.conflicts) {
      const block = Parts.ConflictBlock(c, byId, { onFlag })
      if (block) parts.push(block)
    }
    parts.push(h('div', { class: 'turn__sources' },
      Eyebrow({}, t('ask.sources')),
      h('div', { class: 'turn__source-grid' }, turn.sources.map((s, i) => Parts.SourceCard(s, { n: i + 1, id: `src-${turn.id}-${i + 1}` }))),
    ))
    parts.push(h('p', { class: 'turn__scope' }, scopeLine(turn)))
    if (turn.meta) parts.push(h('p', { class: 'turn__model' }, modelLabel(turn.meta)))
    parts.push(turnActions(turn))
    return parts
  }

  function turnView(turn) {
    return h('article', { class: 'turn', 'data-turn': String(turn.id) },
      h('div', { class: 'turn__q' }, Eyebrow({}, t('ask.you')), h('p', { class: 'turn__qtext' }, turn.query)),
      Card({ variant: 'outline', class: 'turn__a' }, ...answerBody(turn)),
    )
  }

  function composer() {
    const field = h('textarea', { class: 'v-control composer__field', rows: 2, placeholder: t('ask.placeholder', { client: App.clientName(App.activeClient) }), 'aria-label': t('ask.fieldLabel'), onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    } })
    const submit = () => { const q = field.value; field.value = ''; ask(q) }
    return h('form', { class: 'composer', onSubmit: (e) => { e.preventDefault(); submit() } }, field, Button({ type: 'submit', iconAfter: 'arrow-right', disabled: !!state.busy }, t('ask.submit')))
  }

  function hero() {
    const shortcuts = [['proposal', 'ask.shortcut.proposal'], ['summary', 'ask.shortcut.summary'], ['promised', 'ask.shortcut.promised']]
    return h('div', { class: 'ask__hero' },
      Eyebrow({}, t('ask.eyebrow', { client: App.clientName(App.activeClient) })),
      Statement({ turn: t('ask.turn'), support: t('ask.support') }, t('ask.statement')),
    )
  }

  function shortcuts() {
    const items = [['proposal', 'ask.shortcut.proposal'], ['summary', 'ask.shortcut.summary'], ['promised', 'ask.shortcut.promised']]
    return h('div', { class: 'ask__shortcuts', role: 'group', 'aria-label': t('ask.shortcuts') },
      items.map(([kind, label]) => Tag({ variant: 'outline', onClick: () => ask(shortcutPrompt(kind), { display: shortcutPrompt(kind) }) }, t(label))))
  }

  function draw() {
    const empty = !state.turns.length
    const keep = host.querySelector('.composer__field')
    const draft = keep ? keep.value : ''
    const hadFocus = keep && document.activeElement === keep
    const c = composer()
    mount(host,
      h('div', { class: 'ask' + (empty ? '' : ' ask--thread') },
        empty ? hero() : null,
        empty ? c : null,
        empty ? shortcuts() : null,
        empty ? null : h('div', { class: 'ask__thread' }, state.turns.map(turnView)),
        empty ? null : h('div', { class: 'ask__dock' }, c),
      ),
    )
    const field = host.querySelector('.composer__field')
    if (field) { field.value = draft; if (hadFocus) field.focus() }
  }

  g.AskScreen = {
    render(el) {
      host = el
      draw()
      if (!state.turns.length) host.querySelector('.composer__field')?.focus()
    },
    /** Para testes e para o roteador: reinicia a conversa ao trocar de cliente. */
    reset: resetConversation,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
