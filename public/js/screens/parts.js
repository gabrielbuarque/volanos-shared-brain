/**
 * Peças de tela reaproveitadas: cartão de fonte, bloco de conflito, esqueleto, estados vazio e de erro.
 * Estado se mostra por forma e texto, nunca por cor.
 */
;(function (g) {
  const { h, cx, Card, Tag, LevelPill, Button, Eyebrow, Rule } = g.VUI
  const STALE_DAYS = 180

  function authorName(author) {
    return author === 'You' ? t('common.you') : author || t('common.unknownAuthor')
  }

  /** Rótulo do estado de revisão como Tag: verificado é cheio, os outros são contorno. "Não revisado" é cinza. */
  function ReviewTag(state) {
    return Tag({ variant: state === 'verified' ? 'solid' : state ? 'outline' : 'neutral', class: 'review-tag' }, g.Fmt.reviewLabel(state))
  }

  /**
   * Cartão de uma fonte: título, autor, data, estado, nível e (se for o caso) "pode estar desatualizada".
   * `n` é o número da citação [n]. O trecho abre em <details>; "Abrir" leva ao documento.
   */
  function SourceCard(src, { n, id, open = false } = {}) {
    const title = g.Fmt.titleOf(src.content) || t('source.untitled')
    const body = g.Fmt.bodyOf(src.content) || src.content
    const when = src.updated_at || src.created_at
    const card = Card({ variant: 'outline', class: 'source', id, tabindex: '-1', 'data-source-id': src.id },
      h('div', { class: 'source__head' },
        n ? h('span', { class: 'source__n', 'aria-hidden': 'true' }, `[${n}]`) : null,
        h('h3', { class: 'source__title' }, title),
        LevelPill({ level: src.clearance_level, text: g.App.levelText(src.clearance_level), size: 'sm' }),
      ),
      h('p', { class: 'source__meta' },
        authorName(src.workspace === 'personal' ? 'You' : src.author), ' · ',
        h('time', { datetime: new Date(when).toISOString(), title: formatDateUI(when) }, g.Fmt.relativeTime(when)),
        ' · ', g.Fmt.sourceKindLabel(src.source),
      ),
      h('div', { class: 'source__tags' },
        src.workspace === 'personal' ? Tag({ variant: 'solid', class: 'source__private' }, t('source.private')) : null,
        ReviewTag(src.review_state),
        src.stale ? Tag({ variant: 'outline', class: 'source__stale' }, t('source.stale')) : null,
      ),
      h('details', { class: 'source__details', open: open || undefined },
        h('summary', null, t('source.excerpt')),
        h('div', { class: 'source__body' }, body),
        h('a', { class: 'source__open', href: `#/doc/${encodeURIComponent(src.id)}` }, t('source.openDoc')),
      ),
    )
    return card
  }

  const REVIEW_RANK = { verified: 2, reviewed: 1 }

  /** Qual lado prevalece e por quê: canônica do owner, depois revisada, depois a mais recente. */
  function precedence(a, b) {
    const ra = REVIEW_RANK[a.review_state] || 0
    const rb = REVIEW_RANK[b.review_state] || 0
    if (ra !== rb) return { id: ra > rb ? a.id : b.id, why: (ra > rb ? ra : rb) === 2 ? 'canon' : 'review' }
    const ta = Number(a.updated_at || a.created_at)
    const tb = Number(b.updated_at || b.created_at)
    if (ta === tb) return { id: null, why: null }
    return { id: ta > tb ? a.id : b.id, why: 'recent' }
  }

  /** Dois valores lado a lado, cada um com sua fonte, data e autor, e o botão de sinalizar. */
  function ConflictBlock(conflict, byId, { onFlag } = {}) {
    const a = byId.get(conflict.a)
    const b = byId.get(conflict.b)
    if (!a || !b) return null
    const win = precedence(a, b)
    const side = (s, value) =>
      h('div', { class: 'conflict__side' },
        value ? h('div', { class: 'conflict__value' }, value) : null,
        h('p', { class: 'conflict__who' }, g.Fmt.titleOf(s.content)),
        h('p', { class: 'source__meta' }, authorName(s.author), ' · ', formatDateUI(s.updated_at || s.created_at)),
        h('div', { class: 'source__tags' }, win.id === s.id ? Tag({ variant: 'solid' }, t('conflict.prevails.' + win.why)) : null, ReviewTag(s.review_state)),
      )
    const flag = Button({ variant: 'secondary', size: 'sm', onClick: () => onFlag && onFlag(conflict, flag) }, t('conflict.flag'))
    return h('section', { class: 'conflict', 'aria-label': t('conflict.title') },
      Eyebrow({}, t('conflict.title')),
      h('p', { class: 'conflict__lead' }, t('conflict.lead')),
      h('div', { class: 'conflict__pair' }, side(a, conflict.a_value), h('div', { class: 'conflict__vs', 'aria-hidden': 'true' }, t('conflict.vs')), side(b, conflict.b_value)),
      h('p', { class: 'v-caption' }, t('conflict.rule')),
      flag,
    )
  }

  /**
   * Diferença entre duas versões. Estado por forma e texto, não por cor: linha adicionada leva "+" e régua grossa,
   * removida leva "−" e riscado. Só as linhas que mudaram, com uma de contexto.
   */
  function Diff(before, after) {
    const ops = g.Fmt.lineDiff(before, after)
    const keep = new Set()
    ops.forEach((o, i) => { if (o.t !== 'same') { keep.add(i); keep.add(i - 1); keep.add(i + 1) } })
    const rows = []
    let gap = false
    ops.forEach((o, i) => {
      if (!keep.has(i)) { gap = true; return }
      if (gap && rows.length) rows.push(h('div', { class: 'diff__gap', 'aria-hidden': 'true' }, '…'))
      gap = false
      const mark = o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''
      const label = o.t === 'add' ? t('history.added') : o.t === 'del' ? t('history.removed') : null
      rows.push(h('div', { class: 'diff__row diff__row--' + o.t },
        h('span', { class: 'diff__mark', 'aria-hidden': 'true' }, mark),
        label ? h('span', { class: 'v-sr-only' }, label + ': ') : null,
        h('span', { class: 'diff__text' }, o.text || ' ')))
    })
    return h('div', { class: 'diff', role: 'group', 'aria-label': t('history.diffLabel') }, rows.length ? rows : h('p', { class: 'v-caption' }, t('history.noChange')))
  }

  /** Erro de formulário em português: a mensagem do servidor é em inglês e não é para a pessoa. */
  function failText(e) {
    return e && e.status && e.status < 500 && e.status !== 401 && e.status !== 403 ? t('admin.invalidData') : t('error.body')
  }

  /** Esqueleto sutil: barras em cinza neutro, sem animação para quem prefere menos movimento. */
  function Skeleton({ lines = 3 } = {}) {
    return h('div', { class: 'skeleton', role: 'status', 'aria-label': t('common.loading') },
      Array.from({ length: lines }, (_, i) => h('span', { class: 'skeleton__line', style: { width: i === 0 ? '78%' : i === lines - 1 ? '46%' : '92%' } })),
    )
  }

  /** Estado vazio: o que falta, em uma frase, e o próximo passo. `actions` são botões. */
  function EmptyState({ title, body, actions = [], class: klass } = {}) {
    return h('div', { class: cx('state', klass) }, h('h3', { class: 'state__title' }, title), body ? h('p', { class: 'state__body' }, body) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null)
  }

  /** Erro em linguagem humana. Erro = borda navy mais grossa, sem cor de alerta. */
  function ErrorState({ title, body, onRetry } = {}) {
    return h('div', { class: 'state state--error', role: 'alert' }, h('h3', { class: 'state__title' }, title || t('error.title')), h('p', { class: 'state__body' }, body || t('error.body')), onRetry ? h('div', { class: 'state__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: onRetry }, t('common.retry'))) : null)
  }

  g.Parts = { failText, SourceCard, ConflictBlock, Diff, Skeleton, EmptyState, ErrorState, ReviewTag, authorName, STALE_DAYS }
})(typeof globalThis !== 'undefined' ? globalThis : window)
