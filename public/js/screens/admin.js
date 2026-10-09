/**
 * Admin (só admin): Pessoas (matriz pessoas x níveis e "Ver como"), Convites (Google), Integrações,
 * Auditoria de permissões e Avançado (js/screens/admin-advanced.js).
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Input, Select, Checkbox, Tabs, LevelPill, Tag } = g.VUI
  const { Parts, App, Session } = g
  const MODEL_KEY = 'sb_llm_choice'

  const levelOptions = (selected) => Array.from({ length: 13 }, (_, n) => ({ value: String(n), label: `P${n} · ${(App.levels[n] && App.levels[n].holders) || ''}` }))

  /** Escolha de modelo (Avançado). Só o admin muda; a resposta mostra apenas um "respondido por" discreto. */
  function modelChoice() {
    try { return JSON.parse(localStorage.getItem(MODEL_KEY) || 'null') } catch (e) { return null }
  }

  const when = (ms) => formatDateUI(ms, { day: '2-digit', month: 'short', year: 'numeric' })

  /* ---------- Pessoas ---------- */

  /** Uma linha da matriz: P0..P12 preenchido onde a pessoa lê (nível dela até P12). */
  function matrixCells(floor, name) {
    return Array.from({ length: 13 }, (_, n) => h('span', { class: 'matrix__cell' + (n >= floor ? ' is-read' : ''), role: 'img', 'aria-label': n >= floor ? t('admin.matrix.reads', { name, level: `P${n}` }) : t('admin.matrix.blocked', { name, level: `P${n}` }) }))
  }

  async function peoplePanel(host) {
    mount(host, Parts.Skeleton({ lines: 5 }))
    let members
    try { members = (await Session.api('/team/members')).members } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => peoplePanel(host) })); return }
    const pending = members.filter((m) => m.approvalStatus === 'pending')
    const active = members.filter((m) => m.approvalStatus !== 'pending')

    const pendingBlock = pending.length
      ? h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.pending')),
        pending.map((m) => {
          const level = Select({ label: t('admin.level'), options: levelOptions(), value: '12' })
          return Card({ variant: 'outline', class: 'personrow' }, h('strong', null, m.name), h('span', { class: 'v-caption' }, m.email || ''), level,
            Button({ variant: 'secondary', size: 'sm', onClick: async () => {
              try { await Session.api('/team/members/approve', { method: 'POST', body: { id: m.userId, clearance_floor: Number(level.control.value) } }); g.VUI.toast(t('admin.approved')); peoplePanel(host) } catch (e) { g.VUI.toast(e.message) }
            } }, t('admin.approve')))
        })) : null

    const head = h('div', { class: 'matrix__head', 'aria-hidden': 'true' }, Array.from({ length: 13 }, (_, n) => h('span', null, `P${n}`)))
    const rows = active.map((m) => {
      const floor = m.role === 'admin' ? 0 : m.clearanceFloor
      const select = Select({ label: t('admin.level'), options: levelOptions(), value: String(floor), disabled: m.role === 'admin', class: 'matrix__select', onChange: async (e) => {
        try { await Session.api('/permissions/members/clearance', { method: 'POST', body: { id: m.userId, clearance_floor: Number(e.target.value) } }); g.VUI.toast(t('admin.levelSaved', { name: m.name })); peoplePanel(host) } catch (err) { g.VUI.toast(err.message) }
      } })
      const direct = Checkbox({ label: t('admin.directPublish'), checked: m.directPublish, onChange: async (e) => {
        try { await Session.api('/team/members/direct-publish', { method: 'POST', body: { id: m.userId, direct_publish: e.target.checked } }) } catch (err) { e.target.checked = !e.target.checked; g.VUI.toast(err.message) }
      } })
      const canView = m.userId !== Session.me.userId && !m.suspended
      return h('div', { class: 'matrix__row' },
        h('div', { class: 'matrix__who' }, h('strong', null, m.name), m.role === 'admin' ? Tag({ variant: 'outline' }, t('admin.roleAdmin')) : null, m.suspended ? Tag({ variant: 'neutral' }, t('admin.suspended')) : null, h('span', { class: 'v-caption' }, m.email || '')),
        h('div', { class: 'matrix__cells' }, matrixCells(floor, m.name)),
        h('div', { class: 'matrix__tools' }, select, m.role === 'admin' ? null : direct,
          canView ? Button({ variant: 'ghost', size: 'sm', onClick: () => g.Shell.enterViewAs({ id: m.userId, name: m.name, clearanceFloor: floor }) }, t('admin.viewAs')) : null),
      )
    })
    mount(host, pendingBlock,
      h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.matrix.title')), h('p', { class: 'v-caption' }, t('admin.matrix.note')),
        h('div', { class: 'matrix', role: 'group', 'aria-label': t('admin.matrix.title') }, h('div', { class: 'matrix__row matrix__row--head' }, h('div'), head, h('div')), rows)))
  }

  /* ---------- Convites ---------- */

  async function invitesPanel(host) {
    const email = Input({ label: t('admin.invite.email'), type: 'email', placeholder: 'nome@volanos.ca', autocomplete: 'off' })
    const role = Select({ label: t('admin.invite.role'), options: [{ value: 'member', label: t('admin.invite.member') }, { value: 'admin', label: t('admin.roleAdmin') }], value: 'member' })
    const level = Select({ label: t('admin.level'), options: levelOptions(), value: '7' })
    const preview = h('p', { class: 'v-caption' })
    const linkHost = h('div', { 'aria-live': 'polite' })
    const listHost = h('div')
    const paintPreview = () => { preview.textContent = t('admin.invite.preview', { text: App.levelText(Number(level.control.value)) }) }
    level.control.addEventListener('change', paintPreview)
    paintPreview()
    const showLink = (link, to) => {
      const copy = Button({ variant: 'secondary', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(link); g.VUI.toast(t('admin.invite.copied')) } catch (e) { g.VUI.toast(t('admin.invite.copyManual')) } } }, t('admin.invite.copy'))
      mount(linkHost, Card({ variant: 'outline', class: 'linkbox' }, h('p', { class: 'v-caption' }, t('admin.invite.linkFor', { email: to })), h('code', null, link), copy))
    }
    async function list() {
      try {
        const { invites } = await Session.api('/team/invites')
        mount(listHost, invites.length ? h('div', { class: 'admin__list' }, invites.map((i) => h('div', { class: 'listrow' },
          h('span', null, i.email), LevelPill({ level: i.clearance_floor, size: 'sm' }), h('span', { class: 'v-caption' }, t('admin.invite.expires', { when: when(i.expires_at) })),
          Button({ variant: 'ghost', size: 'sm', onClick: async () => { try { const r = await Session.api('/team/invites/resend', { method: 'POST', body: { id: i.id } }); showLink(r.link, i.email) } catch (e) { g.VUI.toast(e.message) } } }, t('admin.invite.resend')),
          Button({ variant: 'ghost', size: 'sm', onClick: async () => { try { await Session.api('/team/invites/cancel', { method: 'POST', body: { id: i.id } }); list() } catch (e) { g.VUI.toast(e.message) } } }, t('admin.invite.cancel')),
        ))) : h('p', { class: 'v-caption' }, t('admin.invite.none')))
      } catch (e) { mount(listHost, Parts.ErrorState({ onRetry: list })) }
    }
    const form = h('form', { class: 'admin__form', onSubmit: async (e) => {
      e.preventDefault()
      const to = email.control.value.trim()
      if (!to) return
      try {
        const r = await Session.api('/team/invites', { method: 'POST', body: { email: to, role: role.control.value, clearance_floor: Number(level.control.value) } })
        showLink(r.link, to)
        email.control.value = ''
        list()
      } catch (err) { g.VUI.toast(err.message) }
    } }, email, role, level, preview, Button({ type: 'submit' }, t('admin.invite.create')))
    mount(host, h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.invite.title')), h('p', { class: 'v-caption' }, t('admin.invite.note')), form, linkHost), h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.invite.open')), listHost))
    list()
  }

  /* ---------- Auditoria ---------- */

  function eventText(ev) {
    const key = 'admin.audit.event.' + ev.event
    const base = t(key)
    const text = base === key ? ev.event : base
    const extra = ev.payload && ev.payload.clearanceFloor !== undefined ? ` (P${ev.payload.clearanceFloor})` : ev.payload && ev.payload.level !== undefined ? ` (P${ev.payload.level})` : ''
    return text + extra
  }

  async function auditPanel(host) {
    let group = 'permissions'
    const list = h('div', { class: 'admin__list' })
    const more = Button({ variant: 'secondary', size: 'sm', onClick: () => load(true) }, t('admin.audit.more'))
    more.hidden = true
    let cursor = null
    async function load(append) {
      if (!append) { cursor = null; mount(list, Parts.Skeleton({ lines: 4 })) }
      const q = new URLSearchParams({ n: '30', group })
      if (cursor) q.set('before', String(cursor))
      try {
        const r = await Session.api('/admin/audit?' + q)
        const rows = r.events.map((ev) => h('div', { class: 'listrow' }, h('span', { class: 'v-caption' }, formatDateUI(ev.created_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })), h('span', null, eventText(ev)), h('span', { class: 'v-caption' }, [ev.actor, ev.target && ev.target !== ev.actor ? ` → ${ev.target}` : ''].join(''))))
        if (append) rows.forEach((r2) => list.appendChild(r2)); else mount(list, rows.length ? rows : h('p', { class: 'v-caption' }, t('admin.audit.empty')))
        cursor = r.events.length ? r.events[r.events.length - 1].created_at : cursor
        more.hidden = !r.more
      } catch (e) { mount(list, Parts.ErrorState({ onRetry: () => load(false) })) }
    }
    const tabs = Tabs({ variant: 'pill', label: t('admin.audit.title'), value: 'permissions', items: [{ id: 'permissions', label: t('admin.audit.permissions') }, { id: 'all', label: t('admin.audit.all') }], onChange: (id) => { group = id; load(false) } })
    mount(host, h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.audit.title')), h('p', { class: 'v-caption' }, t('admin.audit.note')), tabs, list, more))
    load(false)
  }

  /* ---------- Integrações ---------- */

  function connectDialog(info, reload) {
    const token = Input({ label: info.connectLabel || t('admin.int.token'), type: 'password', placeholder: info.connectPlaceholder || '', autocomplete: 'off', 'data-autofocus': '' })
    const err = h('div', { 'aria-live': 'polite' })
    const extra = []
    let repo, ref, path, folder, level
    if (info.provider === 'github') { repo = Input({ label: t('admin.int.repo'), placeholder: 'owner/repository' }); ref = Input({ label: t('admin.int.branch'), placeholder: 'main' }); path = Input({ label: t('admin.int.path') }); extra.push(repo, ref, path) }
    if (info.provider === 'google-drive') { folder = Input({ label: t('admin.int.folder'), placeholder: 'root' }); extra.push(folder) }
    if (repo || folder) { level = Select({ label: t('admin.int.defaultLevel'), options: levelOptions(), value: '8' }); extra.push(level) }
    const d = g.VUI.openDialog({ title: t('admin.int.connectTitle', { name: info.name }) }, info.connectHint ? h('p', { class: 'v-caption' }, info.connectHint.replace(/<[^>]+>/g, '')) : null,
      info.authKind === 'oauth2' ? null : token, extra, err,
      h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('common.cancel')), Button({ onClick: async (e) => {
        e.currentTarget.disabled = true
        const config = {}
        if (repo) Object.assign(config, { repo: repo.control.value.trim(), ref: ref.control.value.trim() || 'main', path: path.control.value.trim(), defaultClearance: Number(level.control.value) })
        if (folder) Object.assign(config, { folderId: folder.control.value.trim() || 'root', defaultClearance: Number(level.control.value) })
        try {
          if (info.authKind === 'oauth2') {
            const r = await Session.api(`/integrations/${info.provider}/oauth/start`, { method: 'POST', body: { workspace: 'company', ...(Object.keys(config).length ? { config } : {}) } })
            window.location.href = r.redirectUrl
            return
          }
          await Session.api(`/integrations/${info.provider}/connect`, { method: 'POST', body: { token: token.control.value.trim(), workspace: 'company', ...(Object.keys(config).length ? { config } : {}) } })
          d.close()
          reload()
        } catch (ex) { e.currentTarget.disabled = false; mount(err, h('p', { class: 'form-error', role: 'alert' }, ex.message)) }
      } }, info.authKind === 'oauth2' ? t('admin.int.authorize') : t('login.connect'))))
  }

  async function integrationsPanel(host) {
    mount(host, Parts.Skeleton({ lines: 4 }))
    try {
      const { integrations } = await Session.api('/integrations')
      mount(host, h('section', { class: 'admin__section' }, Eyebrow({}, t('admin.int.title')), h('p', { class: 'v-caption' }, t('admin.int.note')),
        h('div', { class: 'admin__list' }, integrations.map((i) => h('div', { class: 'listrow listrow--wide' },
          h('span', null, h('strong', null, i.name), h('br'), h('span', { class: 'v-caption' }, i.connected ? [t('admin.int.connected'), i.workspaceName ? ` · ${i.workspaceName}` : '', i.lastSyncedAt ? ` · ${t('admin.int.synced', { when: when(i.lastSyncedAt) })}` : ''] : t('admin.int.notConnected'), i.lastSyncError ? ` · ${i.lastSyncError}` : '')),
          i.connected
            ? h('span', { class: 'listrow__actions' }, Button({ variant: 'secondary', size: 'sm', onClick: async () => { try { await Session.api(`/integrations/${i.provider}/sync`, { method: 'POST', body: {} }); g.VUI.toast(t('admin.int.syncDone')); integrationsPanel(host) } catch (e) { g.VUI.toast(e.message) } } }, t('admin.int.sync')),
              Button({ variant: 'ghost', size: 'sm', onClick: async () => { try { await Session.api(`/integrations/${i.provider}/disconnect`, { method: 'POST', body: {} }); integrationsPanel(host) } catch (e) { g.VUI.toast(e.message) } } }, t('admin.int.disconnect')))
            : Button({ variant: 'secondary', size: 'sm', onClick: () => connectDialog(i, () => integrationsPanel(host)) }, t('login.connect')))))))
    } catch (e) { mount(host, Parts.ErrorState({ onRetry: () => integrationsPanel(host) })) }
  }

  function render(host, parts) {
    const panels = { pessoas: peoplePanel, convites: invitesPanel, integracoes: integrationsPanel, auditoria: auditPanel, avancado: (el) => g.AdminAdvanced.render(el) }
    const body = h('div', { class: 'admin__body' })
    const items = [['pessoas', 'admin.tab.people'], ['convites', 'admin.tab.invites'], ['integracoes', 'admin.tab.integrations'], ['auditoria', 'admin.tab.audit'], ['avancado', 'admin.tab.advanced']].map(([id, label]) => ({ id, label: t(label) }))
    const start = panels[parts[0]] ? parts[0] : 'pessoas'
    const tabs = Tabs({ label: t('nav.admin'), value: start, items, onChange: (id) => { history.replaceState(null, '', `#/admin/${id}`); mount(body); panels[id](body) } })
    mount(host, h('div', { class: 'page-head' }, Eyebrow({}, t('nav.admin')), h('h1', null, t('admin.title'))), tabs, body)
    panels[start](body)
  }

  g.AdminScreen = { render }
  g.Admin = { modelChoice, MODEL_KEY, levelOptions }
})(typeof globalThis !== 'undefined' ? globalThis : window)
