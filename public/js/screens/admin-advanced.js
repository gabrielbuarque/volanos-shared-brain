/**
 * Admin > Avançado: modelo de IA, textos dos níveis, saúde da memória (aging), exportação e sobre.
 * É para onde foi o que ainda era útil das telas antigas. Nada aqui fica na tela principal.
 */
;(function (g) {
  const { h, mount, Button, Card, Eyebrow, Input, Select } = g.VUI
  const { Parts, App, Session } = g

  const AGING = [
    { job: 'dedup', key: 'AGING_DEDUP' },
    { job: 'contradictions', key: 'AGING_CONTRADICTIONS' },
    { job: 'compact', key: 'AGING_COMPACT' },
  ]
  const when = (ms) => formatDateUI(ms, { day: '2-digit', month: 'short', year: 'numeric' })
  const toast = (m) => g.VUI.toast(m)

  /* ---------- Modelo ---------- */

  async function modelSection() {
    const host = h('section', { class: 'admin__section' }, Eyebrow({}, t('adv.model.title')))
    try {
      const { models } = await Session.api('/llm/models')
      const saved = g.Admin.modelChoice()
      const current = saved ? `${saved.provider}|${saved.model}` : ''
      const select = Select({ label: t('adv.model.label'), hint: t('adv.model.hint'), options: [{ value: '', label: t('adv.model.default') }, ...models.map((m) => ({ value: `${m.provider}|${m.id}`, label: m.label }))], value: current, onChange: (e) => {
        try {
          if (!e.target.value) localStorage.removeItem(g.Admin.MODEL_KEY)
          else { const [provider, ...rest] = e.target.value.split('|'); localStorage.setItem(g.Admin.MODEL_KEY, JSON.stringify({ provider, model: rest.join('|') })) }
          toast(t('adv.model.saved'))
        } catch (err) { /* a escolha vale até recarregar */ }
      } })
      host.appendChild(select)
    } catch (e) { host.appendChild(Parts.ErrorState({})) }
    return host
  }

  /* ---------- Textos dos níveis ---------- */

  function levelsSection() {
    const host = h('section', { class: 'admin__section' }, Eyebrow({}, t('adv.levels.title')), h('p', { class: 'v-caption' }, t('adv.levels.note')))
    const rows = App.levels.map((l) => h('div', { class: 'levelrow', 'data-level': String(l.level) },
      h('strong', null, `P${l.level}`),
      Input({ label: t('adv.levels.holders'), value: l.holders, 'data-f': 'holders' }),
      Input({ label: t('adv.levels.reads'), value: l.reads, 'data-f': 'reads' }),
      Input({ label: t('adv.levels.example'), value: l.example, 'data-f': 'example' })))
    host.appendChild(h('details', { class: 'source__details' }, h('summary', null, t('adv.levels.edit')), h('div', { class: 'levelrows' }, rows),
      Button({ variant: 'secondary', size: 'sm', onClick: async () => {
        const levels = rows.map((row) => ({ level: Number(row.dataset.level), holders: row.querySelector('[data-f=holders]').value, reads: row.querySelector('[data-f=reads]').value, example: row.querySelector('[data-f=example]').value }))
        try { const r = await Session.api('/levels', { method: 'PUT', body: { levels } }); App.levels = r.levels; toast(t('adv.levels.saved')) } catch (e) { toast(g.Parts.failText(e)) }
      } }, t('common.save'))))
    return host
  }

  /* ---------- Saúde da memória ---------- */

  function stat(n, label) {
    return h('div', { class: 'stat' }, h('strong', null, String(n)), h('span', null, label))
  }

  function suggestionCard(s, reload) {
    const side = (x, tag) => h('div', { class: 'conflict__side' }, h('strong', null, `${tag} · ${x.title}`), h('p', { class: 'source__meta' }, `P${x.clearance_level} · ${x.source || ''} · v${x.version} · ${when(x.updated_at)}`), h('p', { class: 'source__body' }, x.excerpt))
    const resolve = async (action, keep) => { try { await Session.api('/memory/suggestions/resolve', { method: 'POST', body: { id: s.id, action, keep } }); toast(action === 'merge' ? t('adv.health.merged') : t('adv.health.dismissed')); reload() } catch (e) { toast(g.Parts.failText(e)) } }
    return Card({ variant: 'outline', class: 'reviewcard' },
      h('strong', null, s.kind === 'duplicate' ? t('adv.health.duplicate') : t('adv.health.divergent')),
      h('div', { class: 'conflict__pair' }, side(s.a, 'A'), h('div', { class: 'conflict__vs', 'aria-hidden': 'true' }, t('conflict.vs')), side(s.b, 'B')),
      h('div', { class: 'state__actions' },
        Button({ variant: 'secondary', size: 'sm', onClick: () => resolve('merge', s.a.id) }, t('adv.health.keepA')),
        Button({ variant: 'secondary', size: 'sm', onClick: () => resolve('merge', s.b.id) }, t('adv.health.keepB')),
        Button({ variant: 'ghost', size: 'sm', onClick: () => resolve('dismiss') }, t('adv.health.ignore'))))
  }

  async function healthSection() {
    const host = h('section', { class: 'admin__section' }, Eyebrow({}, t('adv.health.title')))
    async function load() {
      mount(host, Eyebrow({}, t('adv.health.title')), Parts.Skeleton({ lines: 3 }))
      try {
        const [hh, dup, con] = await Promise.all([Session.api('/admin/memory-health'), Session.api('/memory/suggestions?kind=duplicate'), Session.api('/memory/suggestions?kind=contradiction')])
        const s = hh.health
        mount(host, Eyebrow({}, t('adv.health.title')),
          h('div', { class: 'stats' }, stat(s.duplicates_open, t('adv.health.dups')), stat(s.contradictions_open, t('adv.health.cons')), stat(s.cold_memories, t('adv.health.cold', { days: hh.cold_days })), stat(s.compactable_notes, t('adv.health.compactable'))),
          h('div', { class: 'admin__list' }, AGING.map((j) => {
            const on = hh.flags[j.job]
            return h('div', { class: 'listrow listrow--wide' }, h('span', null, h('strong', null, t('adv.health.job.' + j.job)), h('br'), h('span', { class: 'v-caption' }, t('adv.health.jobHint.' + j.job))),
              h('span', { class: 'listrow__actions' }, h('span', { class: 'v-caption' }, on ? t('adv.health.on') : t('adv.health.off')),
                Button({ variant: 'secondary', size: 'sm', onClick: async () => { try { await Session.api('/config', { method: 'PATCH', body: { [j.key]: on ? 'off' : 'on' } }); load() } catch (e) { toast(g.Parts.failText(e)) } } }, on ? t('adv.health.turnOff') : t('adv.health.turnOn')),
                Button({ variant: 'ghost', size: 'sm', disabled: !on, onClick: async () => { try { const r = await Session.api('/admin/aging/run', { method: 'POST', body: { job: j.job } }); toast(t('adv.health.ran', { scanned: r.scanned, created: r.created })); load() } catch (e) { toast(g.Parts.failText(e)) } } }, t('adv.health.runNow'))))
          })),
          [...dup.suggestions, ...con.suggestions].length ? h('div', { class: 'reviewlist' }, [...dup.suggestions, ...con.suggestions].map((x) => suggestionCard(x, load))) : h('p', { class: 'v-caption' }, t('adv.health.nothing')))
      } catch (e) { mount(host, Eyebrow({}, t('adv.health.title')), Parts.ErrorState({ onRetry: load })) }
    }
    load()
    return host
  }

  /* ---------- Exportação ---------- */

  async function exportSection() {
    const host = h('section', { class: 'admin__section' })
    async function load() {
      mount(host, Eyebrow({}, t('adv.export.title')), Parts.Skeleton({ lines: 3 }))
      try {
        const [st, cfg] = await Promise.all([Session.api('/admin/export/status'), Session.api('/config')])
        const repo = Input({ label: t('adv.export.repo'), value: cfg.config.EXPORT_REPO || '', placeholder: 'dono/repositorio' })
        const branch = Input({ label: t('adv.export.branch'), value: cfg.config.EXPORT_BRANCH || 'main' })
        const out = h('div', { 'aria-live': 'polite' })
        mount(host, Eyebrow({}, t('adv.export.title')),
          h('div', { class: 'conflict' }, h('strong', null, t('adv.export.warnTitle')), h('p', { class: 'conflict__lead' }, t('adv.export.warn'))),
          repo, branch,
          h('p', { class: 'v-caption' }, st.token_configured ? t('adv.export.tokenOk') : t('adv.export.tokenMissing'), ' ', st.enabled ? t('adv.export.enabled') : t('adv.export.disabled'), ' ', t('adv.export.schedule', { schedule: st.schedule })),
          h('p', { class: 'v-caption' }, st.last_run_at ? t('adv.export.last', { when: when(st.last_run_at) }) + (st.last_message ? ` · ${st.last_message}` : '') : t('adv.export.never')),
          h('div', { class: 'state__actions' },
            Button({ variant: 'secondary', size: 'sm', onClick: async () => {
              const r = repo.control.value.trim()
              if (r && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) { toast(t('adv.export.repoFormat')); return }
              try { await Session.api('/config', { method: 'PATCH', body: { EXPORT_REPO: r, EXPORT_BRANCH: branch.control.value.trim() || 'main' } }); toast(t('adv.export.saved')); load() } catch (e) { toast(g.Parts.failText(e)) }
            } }, t('common.save')),
            Button({ variant: 'secondary', size: 'sm', disabled: !st.enabled, onClick: async (e) => {
              e.currentTarget.disabled = true
              mount(out, h('p', { class: 'v-caption', role: 'status' }, t('adv.export.running')))
              try { const r = await Session.api('/admin/export-now', { method: 'POST', body: {} }); mount(out, h('p', { class: 'v-caption' }, r.message || t('adv.export.nothingNew'))); load() } catch (ex) { mount(out, h('p', { class: 'form-error', role: 'alert' }, ex.message)); e.currentTarget.disabled = false }
            } }, t('adv.export.now'))),
          out)
      } catch (e) { mount(host, Eyebrow({}, t('adv.export.title')), Parts.ErrorState({ onRetry: load })) }
    }
    load()
    return host
  }

  /* ---------- Sobre ---------- */

  function aboutSection() {
    return h('section', { class: 'admin__section' }, Eyebrow({}, t('adv.about.title')),
      h('p', { class: 'v-caption' }, t('adv.about.base')),
      h('p', { class: 'v-caption' }, t('adv.about.credits')),
      h('p', null, h('a', { href: '/styleguide' }, t('adv.about.styleguide'))))
  }

  async function render(host) {
    mount(host, h('p', { class: 'v-caption' }, t('common.loading')))
    const upkeepHost = h('div')
    g.DataTools.upkeep(upkeepHost)
    const upkeep = h('section', { class: 'admin__section' }, Eyebrow({}, t('adv.upkeep.title')), h('p', { class: 'v-caption' }, t('adv.upkeep.note')), upkeepHost)
    const sections = await Promise.all([modelSection(), Promise.resolve(levelsSection()), healthSection(), Promise.resolve(upkeep), exportSection(), Promise.resolve(aboutSection())])
    mount(host, ...sections)
  }

  g.AdminAdvanced = { render }
})(typeof globalThis !== 'undefined' ? globalThis : window)
