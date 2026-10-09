/**
 * Formatação e leitura de conteúdo. Classic script. As funções que devolvem nós usam VUI.h
 * e nunca montam HTML por string: texto de documento não vira marcação.
 */
;(function (g) {
  const DAY = 86400000

  /** Primeira linha útil como título: remove "# " e limita o tamanho. */
  function titleOf(content, max = 90) {
    const lines = String(content || '').split('\n').map((l) => l.trim()).filter(Boolean)
    const first = (lines[0] || '').replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '')
    return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first
  }

  /** Corpo sem a linha de título quando ela era um cabeçalho markdown. */
  function bodyOf(content) {
    const lines = String(content || '').split('\n')
    let i = 0
    while (i < lines.length && !lines[i].trim()) i++
    if (i < lines.length && /^#{1,6}\s+/.test(lines[i])) i++
    return lines.slice(i).join('\n').trim()
  }

  /** "há 12 dias", "hoje", "há 5 meses". Datas futuras caem em data completa. */
  function relativeTime(ts, now = Date.now()) {
    const diff = now - Number(ts)
    if (!Number.isFinite(diff)) return ''
    if (diff < 0) return formatDateUI(ts)
    const days = Math.floor(diff / DAY)
    if (days < 1) return t('time.today')
    if (days < 31) return tPlural('time.daysAgo', days)
    if (days < 365) return tPlural('time.monthsAgo', Math.floor(days / 30))
    return tPlural('time.yearsAgo', Math.floor(days / 365))
  }

  /** Origem do dado em palavras. Chaves em source.* do catálogo. */
  function sourceKind(source) {
    const s = String(source || '').toLowerCase()
    for (const k of ['drive', 'calendar', 'notion', 'github', 'email']) if (s.includes(k)) return k
    if (s.includes('meet') || s.includes('transcri') || s.includes('voice')) return 'meeting'
    return 'note'
  }

  function sourceKindLabel(source) {
    return t('source.' + sourceKind(source))
  }

  /** Estado de revisão: draft | reviewed | verified | null (não revisado). */
  function reviewLabel(state) {
    return t('review.' + (state || 'none'))
  }

  /** Lista "a, b e c" de rótulos únicos. */
  function joinList(items) {
    const uniq = [...new Set(items.filter(Boolean))]
    if (uniq.length <= 1) return uniq.join('')
    return uniq.slice(0, -1).join(', ') + ' ' + t('common.and') + ' ' + uniq[uniq.length - 1]
  }

  const INLINE_ANSWER = /\*\*([^*]+)\*\*|`([^`]+)`|\[(\d{1,2})\]/g
  const INLINE_DOC = /\*\*([^*]+)\*\*|`([^`]+)`/g

  /** Quebra um texto em nós: **negrito**, `código` e, quando `cite` é dado, [n] vira chip. */
  function inlineNodes(src, re, cite) {
    const { h } = g.VUI
    const nodes = []
    re.lastIndex = 0
    let last = 0
    let m
    while ((m = re.exec(src))) {
      if (m.index > last) nodes.push(src.slice(last, m.index))
      if (m[1]) nodes.push(h('strong', null, m[1]))
      else if (m[2]) nodes.push(h('code', null, m[2]))
      else nodes.push(cite(Number(m[3]), m[0]))
      last = m.index + m[0].length
    }
    if (last < src.length) nodes.push(src.slice(last))
    return nodes
  }

  /**
   * Resposta em DOM seguro. A primeira linha é a frase direta; o resto, pontos e parágrafos.
   * [n] vira um chip que chama onCite(n). Citações fora do intervalo 1..max voltam a texto.
   */
  function renderAnswer(text, { max = 0, onCite } = {}) {
    const { h } = g.VUI
    const root = h('div', { class: 'answer' })
    const cite = (n, literal) =>
      n >= 1 && n <= max
        ? h('button', { type: 'button', class: 'cite', 'data-cite': String(n), 'aria-label': t('ask.citeLabel', { n }), onClick: () => onCite && onCite(n) }, `[${n}]`)
        : literal
    const inline = (src) => inlineNodes(src, INLINE_ANSWER, cite)
    const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
    let list = null
    let listTag = ''
    let lead = true
    for (const line of lines) {
      const bullet = line.match(/^[-*•]\s+(.*)$/)
      const numbered = line.match(/^\d+[.)]\s+(.*)$/)
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol'
        if (!list || listTag !== tag) {
          list = h(tag, { class: 'answer__list' })
          listTag = tag
          root.appendChild(list)
        }
        list.appendChild(h('li', null, inline((bullet || numbered)[1])))
        lead = false
        continue
      }
      list = null
      const heading = line.match(/^#{1,4}\s+(.*)$/)
      root.appendChild(h('p', { class: lead ? 'answer__lead' : heading ? 'answer__sub' : 'answer__p' }, inline(heading ? heading[1] : line)))
      lead = false
    }
    return root
  }

  /**
   * Documento em DOM seguro, para a leitura editorial. O primeiro cabeçalho # é o título e fica de fora
   * (a tela o desenha em Merriweather). Cada ## abre uma seção separada por uma regra fina navy.
   */
  function renderDocument(text) {
    const { h, Rule } = g.VUI
    const root = h('div', { class: 'doc__body' })
    const inline = (src) => inlineNodes(src, INLINE_DOC, (n, literal) => literal)
    let list = null
    let listTag = ''
    let titleSeen = false
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      const line = raw.trim()
      if (!line) {
        list = null
        continue
      }
      const head = line.match(/^(#{1,4})\s+(.*)$/)
      if (head && !titleSeen && head[1].length === 1) {
        titleSeen = true
        continue
      }
      titleSeen = true
      const bullet = line.match(/^[-*•]\s+(.*)$/)
      const numbered = line.match(/^\d+[.)]\s+(.*)$/)
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol'
        if (!list || listTag !== tag) {
          list = h(tag, { class: 'doc__list' })
          listTag = tag
          root.appendChild(list)
        }
        list.appendChild(h('li', null, inline((bullet || numbered)[1])))
        continue
      }
      list = null
      if (head) {
        if (head[1].length <= 2) root.appendChild(Rule({ class: 'doc__rule' }))
        root.appendChild(h(head[1].length <= 2 ? 'h2' : 'h3', { class: 'doc__h' }, inline(head[2])))
      } else root.appendChild(h('p', { class: 'doc__p' }, inline(line)))
    }
    return root
  }

  /** Texto numerado para o /chat: data por extenso, fonte, autor, estado e aviso de idade. */
  function chatContext(sources) {
    return sources
      .map((m, i) => {
        const date = new Date(m.updated_at || m.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        const bits = [date, m.source, m.author, m.review_state, m.stale ? 'possibly outdated' : ''].filter(Boolean).join(' · ')
        return `${i + 1}. [${bits}]\n${m.content}`
      })
      .join('\n\n')
  }

  g.Fmt = { titleOf, bodyOf, relativeTime, sourceKind, sourceKindLabel, reviewLabel, joinList, renderAnswer, renderDocument, chatContext }
})(typeof globalThis !== 'undefined' ? globalThis : window)
