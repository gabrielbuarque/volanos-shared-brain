/**
 * Equipe. Admin: nome da equipe, modo equipe, padrão de captura da organização, insights semanais, membros com o
 * padrão de captura de cada um e adicionar pessoa (token mostrado uma vez). Nível, suspender, token e remover ficam
 * em Admin > Pessoas. Membro: nome da equipe, quem faz parte e o próprio padrão de captura (só leitura do resto).
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Input, Select, Switch, Tag } = g.VUI
  const { Parts, App, Session } = g

  const shareOptions = (withInherit) => [...(withInherit ? [{ value: 'inherit', label: t('team.shareInherit') }] : []), { value: 'personal', label: t('team.sharePersonal') }, { value: 'company', label: t('team.shareCompany') }]
  const roleLabel = (r) => (r === 'admin' ? t('team.roleAdmin') : t('team.roleMember'))
  const fail = (e) => g.VUI.toast(g.Parts.failText(e))

  /** Chave de texto para "onde a próxima captura cai", como a interface anterior dizia na tela inicial. */
  function captureKey(p) {
    if (!p) return null
    const own = !!p.defaultShare
    if (p.effectiveDefault === 'company') return own ? 'team.autoSharedYours' : 'team.autoSharedOrg'
    return own ? 'team.autoPersonalYours' : 'team.autoPersonalOrg'
  }

  async function readConfig() { try { return (await Session.api('/config')).config || {} } catch (e) { return {} } }
  async function patchConfig(key, value) { await Session.api('/config', { method: 'PATCH', body: { [key]: value } }) }

  function tokenBox(token, name, email) {
    const msg = t('team.inviteBody', { name, url: String(Session.url || window.location.origin).replace(/\/+$/, ''), token })
    const copy = (text, label) => Button({ variant: 'secondary', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(text); g.VUI.toast(t('admin.copied')) } catch (e) { g.VUI.toast(t('admin.copyManual')) } } }, label)
    return Card({ variant: 'outline', class: 'linkbox' }, Eyebrow({}, t('team.tokenTitle', { name })), h('p', { class: 'v-caption' }, t('team.tokenWarning')), h('code', null, token),
      h('div', { class: 'state__actions' }, copy(token, t('admin.tokenCopy')), copy(msg, t('team.copyInvite')), email ? Button({ variant: 'secondary', size: 'sm', href: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(t('team.inviteSubject'))}&body=${encodeURIComponent(msg)}` }, t('team.emailInvite')) : null))
  }

  /* ---------- Admin ---------- */

  async function adminView(host) {
    mount(host, Parts.Skeleton({ lines: 5 }))
    let members, teams, cfg, health
    try {
      ;[members, teams, cfg, health] = await Promise.all([Session.api('/team/members'), Session.api('/team/workspaces').catch(() => ({ teams: [] })), readConfig(), Session.api('/health').catch(() => ({}))])
    } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => adminView(host) })); return }
    const list = members.members || []
    const teamName = (teams.teams && teams.teams[0] && teams.teams[0].name) || ''
    const forced = list.length > 1
    const teamOn = forced || !!health.team

    const name = Input({ label: t('team.nameLabel'), value: teamName, maxlength: 60, autocomplete: 'off', hint: t('team.nameHint') })
    const saveName = Button({ size: 'sm', onClick: async () => {
      const v = name.control.value.trim()
      if (!v) { name.setError(t('team.nameNeeded')); return }
      try { await Session.api('/team/workspaces/rename', { method: 'POST', body: { name: v } }); App.teamName = v; g.VUI.toast(t('team.nameSaved')) } catch (e) { fail(e) }
    } }, t('common.save'))
    name.control.addEventListener('input', () => name.clearError())

    const modeSwitch = Switch({ label: t('team.modeLabel'), checked: teamOn, disabled: forced, onChange: async (e) => {
      try { await patchConfig('TEAM_MODE', e.target.checked ? 'on' : 'off'); await App.load(); g.VUI.toast(e.target.checked ? t('team.modeOnSaved') : t('team.modeOffSaved')) } catch (err) { e.target.checked = !e.target.checked; fail(err) }
    } })
    const orgDefault = Select({ label: t('team.orgDefaultLabel'), options: shareOptions(false), value: cfg.TEAM_DEFAULT_WORKSPACE === 'company' ? 'company' : 'personal', onChange: async (e) => { try { await patchConfig('TEAM_DEFAULT_WORKSPACE', e.target.value) } catch (err) { fail(err) } } })
    const insights = Select({ label: t('team.insightsLabel'), options: [{ value: 'off', label: t('team.insightsOff') }, { value: 'on', label: t('team.insightsOn') }], value: cfg.TEAM_INSIGHTS === 'on' ? 'on' : 'off', hint: t('team.insightsHint'), onChange: async (e) => { try { await patchConfig('TEAM_INSIGHTS', e.target.value) } catch (err) { fail(err) } } })

    const reveal = h('div', { 'aria-live': 'polite' })
    const addName = Input({ label: t('team.addName'), autocomplete: 'off' })
    const addEmail = Input({ label: t('team.addEmail'), type: 'email', autocomplete: 'off' })
    const addRole = Select({ label: t('admin.invite.role'), options: [{ value: 'member', label: t('admin.invite.member') }, { value: 'admin', label: t('admin.roleAdmin') }], value: 'member' })
    const addForm = h('form', { class: 'admin__form', novalidate: true, onSubmit: async (ev) => {
      ev.preventDefault()
      const nm = addName.control.value.trim()
      const em = addEmail.control.value.trim()
      if (!nm) { addName.setError(t('team.needName')); return }
      try {
        const r = await Session.api('/team/members', { method: 'POST', body: { name: nm, ...(em ? { email: em } : {}), role: addRole.control.value } })
        mount(reveal, tokenBox(r.token, (r.member && r.member.name) || nm, em))
        addName.control.value = ''; addEmail.control.value = ''
        adminView(host).then(() => host.prepend(reveal))
      } catch (err) { if (err && err.status === 409) addEmail.setError(t('team.duplicateEmail')); else fail(err) }
    } }, addName, addEmail, addRole, Button({ type: 'submit' }, t('team.addAction')))
    addName.control.addEventListener('input', () => addName.clearError())

    const rows = list.map((m) => {
      const self = m.userId === (Session.me && Session.me.userId)
      const sel = Select({ label: t('team.defaultShareLabel'), options: shareOptions(true), value: m.defaultShare || 'inherit', onChange: async (e) => { try { await Session.api('/team/members/default-share', { method: 'POST', body: { id: m.userId, default: e.target.value } }); g.VUI.toast(t('team.myDefaultSaved')) } catch (err) { fail(err) } } })
      return Card({ variant: 'outline', class: 'personrow' },
        h('div', { class: 'matrix__who' }, h('strong', null, m.name || m.userId), Tag({ variant: 'outline' }, roleLabel(m.role)), self ? Tag({ variant: 'neutral' }, t('team.you')) : null, m.suspended ? Tag({ variant: 'neutral' }, t('admin.suspended')) : null),
        h('p', { class: 'v-caption' }, [m.email, tPlural('team.privateEntries', Number(m.privateEntries) || 0, { n: Number(m.privateEntries) || 0 }), Number(m.lastUsedAt) > 0 ? t('team.lastUsed', { when: g.Fmt.relativeTime(m.lastUsedAt) }) : t('team.lastUsedNever')].filter(Boolean).join(' · ')),
        sel)
    })

    mount(host, reveal,
      h('section', { class: 'admin__section' }, name, h('div', { class: 'state__actions' }, saveName)),
      h('section', { class: 'admin__section' }, Eyebrow({}, t('team.modeTitle')), modeSwitch, h('p', { class: 'v-caption' }, forced ? t('team.modeLocked', { n: formatNumberUI(list.length) }) : t('team.modeHint')),
        orgDefault, teamOn ? insights : null),
      h('section', { class: 'admin__section' }, Eyebrow({}, t('team.membersLabel')), h('p', { class: 'v-caption' }, t('team.manageHint')), h('a', { href: '#/admin/pessoas' }, t('team.manageLink')), h('div', { class: 'admin__list' }, rows)),
      h('section', { class: 'admin__section' }, Eyebrow({}, t('team.addTitle')), addForm))
  }

  /* ---------- Membro ---------- */

  async function memberView(host) {
    mount(host, Parts.Skeleton({ lines: 4 }))
    let roster, me
    try { ;[roster, me] = await Promise.all([Session.api('/team/roster'), Session.api('/team/me').catch(() => ({}))]) } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => memberView(host) })); return }
    const teamName = (roster.teams && roster.teams[0] && roster.teams[0].name) || ''
    const profile = me.profile || {}
    const key = captureKey({ defaultShare: profile.defaultShare, effectiveDefault: profile.effectiveDefault })
    const mine = App.team && key ? Select({ label: t('team.myDefaultLabel'), options: shareOptions(true), value: profile.defaultShare || 'inherit', hint: t(key), onChange: async (e) => {
      try { await Session.api('/team/me/default-share', { method: 'POST', body: { default: e.target.value } }); g.VUI.toast(t('team.myDefaultSaved')); memberView(host) } catch (err) { fail(err); memberView(host) }
    } }) : null
    mount(host,
      teamName ? h('section', { class: 'admin__section' }, Eyebrow({}, t('team.nameLabel')), h('p', null, teamName)) : null,
      mine ? h('section', { class: 'admin__section' }, Eyebrow({}, t('team.yourCaptureTitle')), h('p', { class: 'v-caption' }, t('team.yourCaptureHint')), mine) : null,
      h('section', { class: 'admin__section' }, Eyebrow({}, t('team.membersLabel')), h('div', { class: 'admin__list' }, (roster.members || []).map((m) => h('div', { class: 'listrow' }, h('strong', null, m.name || m.userId), Tag({ variant: 'outline' }, roleLabel(m.role)), m.userId === roster.you ? Tag({ variant: 'neutral' }, t('team.you')) : null))), h('p', { class: 'v-caption' }, t('team.rosterHint'))))
  }

  function render(host, { admin } = {}) {
    return admin ? adminView(host) : memberView(host)
  }

  g.TeamTab = { render, captureKey }
})(typeof globalThis !== 'undefined' ? globalThis : window)
