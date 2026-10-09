/**
 * Atividade do time (só admin): quem mudou o quê, do mais novo ao mais antigo. É um registro: nada aqui se edita.
 * Exporta em CSV (até 1.000 eventos), como a interface anterior.
 */
;(function (g) {
  const { h, mount, Button, Eyebrow } = g.VUI
  const { Parts, Session, Legacy } = g
  const PAGE = 50
  const MAX_EXPORT = 1000

  const EVENT_KEYS = ['member_created', 'member_removed', 'member_suspended', 'member_unsuspended', 'member_token_rotated', 'member_default_share_set', 'member_profile_updated', 'team_renamed', 'integration_connected', 'integration_disconnected', 'member_clearance_set', 'directory_created', 'directory_grant_set', 'contribution_approved', 'contribution_rejected', 'levels_edited', 'member_invited', 'member_invite_cancelled', 'member_joined', 'member_approved', 'member_direct_publish_set', 'export_run', 'rebuild_from_export', 'aging_job_run', 'aging_suggestion_resolved', 'shared', 'unshared', 'insight_confirmed', 'insight_dismissed', 'created', 'updated', 'appended', 'deleted', 'restored', 'edited', 'document_edited', 'edit_proposed', 'canon_proposed', 'view_as_started']
  const label = (ev) => (EVENT_KEYS.includes(ev) ? t('activity.ev.' + ev) : ev || '')
  const validTime = (at) => at !== null && at !== undefined && at !== '' && at !== 0 && !Number.isNaN(new Date(at).getTime())
  const whenText = (at) => (validTime(at) ? new Date(at).toLocaleString(localeTag()) : '')

  function row(r) {
    return h('div', { class: 'listrow' },
      h('span', { class: 'v-caption' }, whenText(r.at)),
      h('span', null, [r.actor || t('activity.unknownActor'), label(r.event), r.subject || '', r.kind === 'entry' ? (r.title ? `“${r.title}”` : t('activity.memoryGone')) : ''].filter(Boolean).join(' · ')))
  }

  async function exportCsv(btn) {
    btn.disabled = true
    try {
      const all = []
      while (all.length < MAX_EXPORT) {
        const d = await Session.api(`/team/activity?limit=${PAGE}&offset=${all.length}`)
        all.push(...(d.events || []))
        if ((d.events || []).length < PAGE) break
      }
      const ts = new Date().toISOString().slice(0, 10)
      Legacy.downloadTextFile(document, Legacy.csvDocument(['when', 'event', 'actor', 'subject', 'memory_id', 'memory', 'detail'], all.map((r) => [validTime(r.at) ? new Date(r.at).toISOString() : '', r.event, r.actor ?? '', r.subject ?? '', r.entryId ?? '', r.title ?? '', JSON.stringify(r.detail ?? {})])), `shared-brain-activity-${ts}.csv`, 'text/csv;charset=utf-8')
    } catch (e) { g.VUI.toast(t('activity.exportFailed')) } finally { btn.disabled = false }
  }

  function render(host) {
    const list = h('div', { class: 'admin__list' })
    const more = Button({ variant: 'secondary', size: 'sm', hidden: true, onClick: () => load(true) }, t('activity.more'))
    const exp = Button({ variant: 'secondary', size: 'sm', onClick: (e) => exportCsv(e.currentTarget) }, t('activity.exportCsv'))
    let rows = []
    mount(host, h('section', { class: 'admin__section' }, Eyebrow({}, t('activity.title')), h('p', { class: 'v-caption' }, t('activity.intro')), list, h('div', { class: 'state__actions' }, exp, more)))
    async function load(append) {
      if (!append) mount(list, Parts.Skeleton({ lines: 4 }))
      try {
        const d = await Session.api(`/team/activity?limit=${PAGE}&offset=${append ? rows.length : 0}`)
        rows = append ? [...rows, ...(d.events || [])] : d.events || []
        mount(list, rows.length ? rows.map(row) : h('p', { class: 'v-caption' }, t('activity.empty')))
        more.hidden = rows.length === 0 || rows.length % PAGE !== 0
      } catch (e) { if (!append) mount(list, Parts.ErrorState({ onRetry: () => load(false) })) }
    }
    load(false)
  }

  g.ActivityTab = { render }
})(typeof globalThis !== 'undefined' ? globalThis : window)
