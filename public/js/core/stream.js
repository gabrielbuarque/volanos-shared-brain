/**
 * Leitura do stream SSE de POST /chat. Classic script.
 *
 * O Workers AI manda dois formatos conforme a linhagem do modelo: `response` direto (Llama) ou
 * `choices[0].delta.content` (linhagem OpenAI). O raciocínio (`reasoning`) nunca é devolvido: o
 * chamador desenha isto como resposta. Espelha extractChunkText/consumeSseLine de src/lib/ai.ts;
 * quem mudar um deve olhar o outro. O primeiro evento (`sb_meta`) nomeia o modelo que respondeu.
 */
;(function (g) {
  function extractChunkText(d) {
    if (d && d.response) return d.response
    const content = d && d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content
    return typeof content === 'string' ? content : ''
  }

  function consumeLine(line, onText, onMeta) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) return
    try {
      const d = JSON.parse(line.slice(6))
      if (d && d.sb_meta) {
        if (onMeta) onMeta(d.sb_meta)
        return
      }
      const text = extractChunkText(d)
      if (text) onText(text)
    } catch (e) {
      // Linha completa e malformada: anomalia rara. Perder uma linha é melhor que perder a resposta.
      if (typeof console !== 'undefined') console.error('stream: linha SSE malformada (ignorada):', e)
    }
  }

  /** Passa um pedaço decodificado pelo buffer de linhas; devolve o resto parcial para a próxima chamada. */
  function feed(buffer, chunk, onText, onMeta) {
    const lines = (buffer + chunk).split('\n')
    const rest = lines.pop() || ''
    for (const line of lines) consumeLine(line, onText, onMeta)
    return rest
  }

  /** Lê o corpo inteiro. onText recebe cada pedaço; resolve com { text, meta }. */
  async function read(res, { onText, signal } = {}) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let meta = null
    const push = (c) => {
      text += c
      if (onText) onText(text)
    }
    const setMeta = (m) => { meta = m }
    try {
      for (;;) {
        if (signal && signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer = feed(buffer, decoder.decode(value, { stream: true }), push, setMeta)
      }
      buffer += decoder.decode()
      if (buffer) consumeLine(buffer, push, setMeta)
    } finally {
      try { reader.releaseLock() } catch (e) { /* já liberado */ }
    }
    return { text, meta }
  }

  g.ChatStream = { extractChunkText, feed, read }
})(typeof globalThis !== 'undefined' ? globalThis : window)
