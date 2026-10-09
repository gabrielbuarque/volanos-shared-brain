/**
 * "Abrir no Claude com este contexto". Gera a instrução do MCP com o cliente e os números das fontes.
 * Nenhum conteúdo sai do Shared Brain: o Claude lê as fontes pelo MCP, com o acesso de quem pergunta.
 */
;(function (g) {
  const { h, Button, Input } = g.VUI

  function buildInstruction({ clientName, ids, question }) {
    return t('claude.instruction', { client: clientName, ids: ids.join(', '), question })
  }

  function open({ clientName, ids, question }) {
    const base = g.Session.url || window.location.origin
    const instruction = buildInstruction({ clientName, ids, question })
    const field = Input({ multiline: true, rows: 5, label: t('claude.instructionLabel'), value: instruction, readonly: true })
    const d = g.VUI.openDialog({ title: t('claude.title') },
      h('p', null, t('claude.body')),
      h('p', { class: 'v-caption' }, t('claude.mcp'), ' ', h('code', null, `${base}/mcp`)),
      field,
      h('div', { class: 'v-dialog__actions' },
        Button({ variant: 'ghost', onClick: () => d.close() }, t('common.close')),
        Button({ variant: 'secondary', onClick: async () => { try { await navigator.clipboard.writeText(instruction); g.VUI.toast(t('claude.copied')) } catch (e) { field.control.select() } } }, t('claude.copy')),
        Button({ href: 'https://claude.ai/new?q=' + encodeURIComponent(instruction), target: '_blank', rel: 'noopener noreferrer', iconAfter: 'arrow-up-right' }, t('claude.open')),
      ))
    return d
  }

  g.ClaudeDialog = { open, buildInstruction }
})(typeof globalThis !== 'undefined' ? globalThis : window)
