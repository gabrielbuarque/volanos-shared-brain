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
  const state = { turns: [], seq: 0, busy: null, mode: 'ask', modeLocked: false, layer: '', tag: '', layerFilter: '', receipt: null, tags: null, brief: null, prefill: '' }

  /** Pergunta ou anotação? "?" ou abertura de pergunta = perguntar; o resto vira anotação. Vazio fica em perguntar. */
  const ASK_OPENERS = /^(who|what|when|where|why|how|which|did|do|does|is|are|was|were|can|could|should|would|will|tell me|show me|find|search|list|quem|qual|quais|quando|onde|por que|porque|como|quanto|quantos|o que|existe|tem|temos|liste|mostre|mostra|busque|ache|resuma)\b/i
  function detectMode(text) {
    const s = String(text || '').trim()
    if (!s) return 'ask'
    return s.endsWith('?') || ASK_OPENERS.test(s) ? 'ask' : 'remember'
  }

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
        if (App.scopeParam(turn.client)) params.set('client', App.scopeParam(turn.client))
        if (state.tag) params.set('tag', state.tag)
        if (state.layerFilter) params.set('workspace', state.layerFilter)
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

  /** Lembrar: grava a anotação (hashtags viram tags). A camada vem do padrão da pessoa, a não ser que ela fixe uma. */
  async function remember(text) {
    const tags = []
    const re = /#([a-zA-ZÀ-ÿ][\w-]*)/g
    let m
    while ((m = re.exec(text)) !== null) tags.push(m[1])
    const content = text.replace(/#[a-zA-ZÀ-ÿ][\w-]*/g, '').replace(/\s+/g, ' ').trim() || text
    try {
      const r = await Session.api('/capture', { method: 'POST', body: { content, tags, source: 'web-ui', ...(state.layer ? { workspace: state.layer } : {}) } })
      state.receipt = r && r.duplicate ? { kind: 'duplicate' } : { kind: 'saved', tags, layer: state.layer || (App.capture && App.capture.effectiveDefault) || 'personal' }
      App.count += r && r.duplicate ? 0 : 1
      if (g.MemoriesScreen) g.MemoriesScreen.reset()
    } catch (e) { state.receipt = { kind: 'failed' } }
    repaint()
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
    const shared = turn.sources.filter((s) => s.workspace !== 'personal')
    const hasPrivate = shared.length !== turn.sources.length
    // Em "todos os clientes", o cliente padrão é o da primeira fonte compartilhada.
    const fromSources = (shared[0] && shared[0].client_id) || App.INTERNAL
    const select = g.VUI.Select({ label: t('canon.client'), options: clients, value: turn.client === App.ALL ? fromSources : turn.client })
    const text = g.VUI.Input({ multiline: true, rows: 7, label: t('canon.text'), value: turn.text })
    const submit = Button({ onClick: async () => {
      submit.disabled = true
      try {
        const r = await Session.api('/canon/propose', { method: 'POST', body: { content: text.control.value, client: select.control.value, source_ids: shared.map((s) => s.id) } })
        d.close()
        g.VUI.toast(r.owner && r.owner.name ? t('canon.done', { owner: r.owner.name }) : t('canon.donePlain'), { title: t('canon.doneTitle') })
      } catch (e) {
        submit.disabled = false
        g.VUI.toast(t('error.body'), { title: t('error.title') })
      }
    } }, t('canon.submit'))
    const d = g.VUI.openDialog({ title: t('canon.title') }, h('p', null, t('canon.body')), hasPrivate ? h('p', { class: 'turn__note', role: 'note' }, t('canon.privateWarn')) : null, select, text, h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), submit))
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
    if (turn.sources.some((s) => s.workspace === 'personal')) parts.push(h('p', { class: 'turn__note' }, t('ask.privateNote')))
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
    const field = h('textarea', { class: 'v-control composer__field', rows: 2, maxlength: 2000, placeholder: t('ask.placeholder', { client: App.clientName(App.activeClient) }), 'aria-label': t('ask.fieldLabel'), onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    }, onInput: () => { if (!state.modeLocked) { state.mode = detectMode(field.value); paintMode() } } })
    const modeBtn = Button({ variant: 'ghost', size: 'sm', type: 'button', 'aria-pressed': 'false', onClick: () => { state.modeLocked = true; state.mode = state.mode === 'ask' ? 'remember' : 'ask'; paintMode() } }, '')
    const sendLabel = h('span')
    const send = Button({ type: 'submit', iconAfter: 'arrow-right', disabled: !!state.busy }, sendLabel)
    const layerSel = App.team ? g.VUI.Select({ label: t('ask.layer'), options: [{ value: '', label: t('ask.layerAuto') }, { value: 'personal', label: t('mem.personalLayer') }, { value: 'company', label: t('mem.sharedLayer') }], value: state.layer, onChange: (e) => { state.layer = e.target.value; paintMode() }, class: 'composer__layer' }) : null
    const hint = h('p', { class: 'v-caption composer__hint', 'aria-live': 'polite' })
    function paintMode() {
      const remembering = state.mode === 'remember'
      modeBtn.textContent = t(remembering ? 'ask.modeRemember' : 'ask.modeAsk')
      modeBtn.setAttribute('aria-pressed', String(remembering))
      sendLabel.textContent = t(remembering ? 'ask.remember' : 'ask.submit')
      if (layerSel) layerSel.hidden = !remembering
      hint.textContent = remembering ? [t('ask.tagsHint'), App.team ? rememberTarget() : ''].filter(Boolean).join(' ') : ''
    }
    const submit = () => {
      const q = field.value.trim()
      if (!q || state.busy) return
      field.value = ''
      if (state.mode === 'remember') { state.receipt = null; remember(q) } else { state.receipt = null; ask(q) }
    }
    paintMode()
    return h('form', { class: 'composer', onSubmit: (e) => { e.preventDefault(); submit() } }, field, send,
      h('div', { class: 'composer__tools' }, modeBtn, layerSel), hint)
  }

  /** Onde a próxima anotação cai, dito em uma frase (o padrão pessoal, o da organização ou a camada fixada). */
  function rememberTarget() {
    if (state.layer === 'personal') return t('team.pinnedPersonal')
    if (state.layer === 'company') return t('team.pinnedShared')
    const key = g.TeamTab && g.TeamTab.captureKey ? g.TeamTab.captureKey(App.capture) : null
    return key ? t(key) : ''
  }

  function receipt() {
    const r = state.receipt
    if (!r) return null
    if (r.kind === 'failed') return Parts.ErrorState({ title: t('ask.receiptFailed'), body: t('error.body') })
    if (r.kind === 'duplicate') return h('p', { class: 'turn__note', role: 'status' }, t('ask.receiptDuplicate'))
    return h('p', { class: 'turn__note', role: 'status' }, [t(r.layer === 'company' ? 'ask.receiptShared' : 'ask.receiptPrivate'), r.tags && r.tags.length ? ' ' + r.tags.map((x) => '#' + x).join(' ') : ''].join(''))
  }

  /** Filtros da busca: por tag e, em equipe, por camada. */
  function filters() {
    if (!state.tags && !state.tagsLoading) {
      state.tagsLoading = true
      Session.api('/tags').then((tags) => { state.tags = g.Legacy.humanTags(Array.isArray(tags) ? tags : []); repaint() }).catch(() => { state.tags = [] }).finally(() => { state.tagsLoading = false })
    }
    const tagOptions = [{ value: '', label: t('mem.allTags') }, ...(state.tags || []).map((x) => ({ value: x, label: x }))]
    return h('details', { class: 'ask__filters' }, h('summary', null, t('ask.filters')),
      h('div', { class: 'mem-filters' },
        g.VUI.Select({ label: t('mem.tag'), options: tagOptions, value: state.tag, onChange: (e) => { state.tag = e.target.value } }),
        App.team ? g.VUI.Select({ label: t('mem.layer'), options: [{ value: '', label: t('mem.allLayers') }, { value: 'personal', label: t('mem.personalLayer') }, { value: 'company', label: t('mem.sharedLayer') }], value: state.layerFilter, onChange: (e) => { state.layerFilter = e.target.value } }) : null))
  }

  function hero() {
    const shortcuts = [['proposal', 'ask.shortcut.proposal'], ['summary', 'ask.shortcut.summary'], ['promised', 'ask.shortcut.promised']]
    return h('div', { class: 'ask__hero' },
      Eyebrow({}, t('ask.eyebrow', { client: App.clientName(App.activeClient) })),
      Statement({ turn: t('ask.turn'), support: t('ask.support') }, t('ask.statement')),
      App.count ? h('p', { class: 'v-caption' }, tPlural('ask.count', App.count, { n: formatNumberUI(App.count) })) : h('ol', { class: 'first-run' }, [1, 2, 3].map((n) => h('li', null, t('ask.firstRun.' + n)))),
    )
  }

  function shortcuts() {
    const items = [['proposal', 'ask.shortcut.proposal'], ['summary', 'ask.shortcut.summary'], ['promised', 'ask.shortcut.promised']]
    return h('div', { class: 'ask__shortcuts', role: 'group', 'aria-label': t('ask.shortcuts') },
      items.map(([kind, label]) => Tag({ variant: 'outline', onClick: () => {
        // Sem um cliente escolhido o atalho não sabe de quem falar: preenche o começo da pergunta e deixa a pessoa completar.
        if (App.activeClient === App.ALL || App.activeClient === App.INTERNAL) {
          const f = host.querySelector('.composer__field')
          if (f) { f.value = t('ask.starter.' + kind); f.focus(); f.setSelectionRange(f.value.length, f.value.length) }
          return
        }
        ask(shortcutPrompt(kind), { display: shortcutPrompt(kind) })
      } }, t(label))))
  }

  /** Sugestões da interface anterior: perguntas prontas e dois recortes de tempo. */
  function suggestions() {
    const items = ['workingOn', 'decided', 'tasks', 'goals', 'ideas', 'lastWeek', 'thisMonth']
    return h('div', { class: 'ask__shortcuts', role: 'group', 'aria-label': t('ask.suggestions') },
      items.map((k) => Tag({ variant: 'neutral', onClick: () => { state.mode = 'ask'; state.modeLocked = true; ask(t('ask.sug.' + k)) } }, t('ask.sug.' + k + 'Label'))))
  }

  /** Temas do resumo: um toque pergunta sobre o tema. */
  function topics() {
    if (state.brief === null && !state.briefLoading) {
      state.briefLoading = true
      Session.api('/brief').then((d) => { state.brief = d; repaint() }).catch(() => { state.brief = false }).finally(() => { state.briefLoading = false })
    }
    const list = ((state.brief && state.brief.topics) || []).filter((x) => !g.Legacy.isSystemTag(x.tag)).slice(0, 4)
    return list.length ? h('div', { class: 'ask__shortcuts', role: 'group', 'aria-label': t('ask.topics') }, list.map((x) => Tag({ variant: 'outline', onClick: () => ask(t('brief.askAbout', { tag: x.tag })) }, `${x.tag} · ${x.count}`))) : null
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
        receipt(),
        empty ? shortcuts() : null,
        empty ? suggestions() : null,
        empty ? topics() : null,
        empty ? filters() : null,
        empty ? null : h('div', { class: 'ask__thread' }, state.turns.map(turnView)),
        empty ? null : h('div', { class: 'ask__dock' }, receipt(), c),
      ),
    )
    const field = host.querySelector('.composer__field')
    if (field) { field.value = draft; if (hadFocus) field.focus() }
  }

  g.AskScreen = {
    render(el) {
      host = el
      draw()
      if (state.prefill) { const f = host.querySelector('.composer__field'); if (f) { f.value = state.prefill; f.dispatchEvent(new Event('input')) } state.prefill = '' }
      if (!state.turns.length) host.querySelector('.composer__field')?.focus()
    },
    /** Preenche o campo na próxima vez que a tela abrir (usado pelo resumo). */
    prefill(text) { state.prefill = String(text || ''); state.mode = 'ask'; state.modeLocked = true },
    /** Para testes e para o roteador: reinicia a conversa ao trocar de cliente. */
    reset: resetConversation,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
