/**
 * /styleguide: todos os componentes do Volanos UI, em todos os estados.
 * Só admin: a página pede /permissions/me e recusa quem não for admin.
 * Hover e foco aparecem com as classes .is-hover e .is-focus, que espelham os pseudo-estados.
 * Textos em js/i18n-pt.js e js/i18n-en.js (chaves sg.*).
 */
;(function (g) {
  const { h, mount, Button, IconButton, Card, LevelPill, Tag, Tabs, Input, Select, Checkbox, Switch, Eyebrow, Statement, Rule, Logo, Tooltip } = g.VUI

  const STATES = ['default', 'hover', 'focus', 'disabled']

  function section(id, title, note, ...body) {
    return h('section', { class: 'sg-section', id }, h('div', { class: 'sg-section__head' }, Eyebrow({}, t('sg.nav.' + id)), h('h2', null, title), note ? h('p', { class: 'v-caption' }, note) : null), ...body)
  }

  /** Uma linha por variante, uma coluna por estado. `make(classe, desabilitado)` devolve o elemento. */
  function stateRow(label, make) {
    return h(
      'div',
      { class: 'sg-row' },
      h('div', { class: 'sg-row__label' }, label),
      ...STATES.map((s) => h('div', { class: 'sg-cell' }, h('div', { class: 'sg-cell__state' }, t('sg.state.' + s)), make(s === 'hover' ? 'is-hover' : s === 'focus' ? 'is-focus' : '', s === 'disabled'))),
    )
  }

  function simpleRow(label, ...cells) {
    return h('div', { class: 'sg-row' }, h('div', { class: 'sg-row__label' }, label), ...cells.map((c) => h('div', { class: 'sg-cell' }, c)))
  }

  /** O valor do token vem do CSS vivo: o styleguide nunca repete um hex. */
  function swatch(key, token) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
    return h('div', { class: 'sg-swatch' }, h('div', { class: 'sg-swatch__chip', style: { background: `var(${token})` } }), h('div', { class: 'sg-swatch__name' }, t('sg.color.' + key + '.name')), h('div', { class: 'v-caption' }, value, ' · ', t('sg.color.' + key + '.use')))
  }

  function typeSpecimen(label, cls, text) {
    return h('div', { class: 'sg-type' }, h('div', { class: 'sg-type__label' }, label), h('div', { class: cls }, text))
  }

  function build() {
    const toc = ['brand', 'color', 'buttons', 'pills', 'tabs', 'fields', 'cards', 'feedback']
    const page = h('div', { class: 'sg' })
    page.appendChild(
      h(
        'header',
        { class: 'sg-header' },
        Logo({ width: 140 }),
        h('div', null, Eyebrow({}, t('sg.eyebrow')), h('h1', null, t('sg.title')), h('p', { class: 'v-caption' }, t('sg.intro'))),
        h('nav', { class: 'sg-toc', 'aria-label': t('sg.tocLabel') }, toc.map((id) => h('a', { href: '#' + id }, t('sg.nav.' + id)))),
      ),
    )

    page.appendChild(
      section(
        'brand',
        t('sg.brand.title'),
        t('sg.brand.note'),
        h('div', { class: 'sg-stack' },
          h('div', { class: 'sg-logos' }, Logo({ width: 200 }), Logo({ variant: 'symbol', width: 48 }), Logo({ variant: 'symbol', outline: true, width: 48 }), h('div', { class: 'sg-logos__inv v-inverse' }, Logo({ tone: 'white', width: 160 }), Logo({ variant: 'symbol', tone: 'white', width: 40 }))),
          Eyebrow({}, t('sg.brand.eyebrowDemo')),
          Statement({ turn: t('sg.brand.statementTurn'), support: t('sg.brand.statementSupport') }, t('sg.brand.statement')),
          Rule({}),
          h('p', { class: 'v-caption' }, t('sg.brand.ruleNote')),
          Rule({ hair: true }),
        ),
      ),
    )

    page.appendChild(
      section(
        'color',
        t('sg.color.title'),
        t('sg.color.note'),
        h('div', { class: 'sg-swatches' }, [['blue', '--volanos-blue'], ['deep', '--volanos-blue-deep'], ['light', '--light-blue'], ['gray', '--neutral-gray'], ['lead', '--lead-grey'], ['off', '--off-white']].map(([k, tok]) => swatch(k, tok))),
        h('div', { class: 'sg-stack' },
          typeSpecimen(t('sg.type.eyebrow'), 'v-eyebrow', t('sg.type.eyebrowText')),
          typeSpecimen(t('sg.type.lede'), 'v-lede', t('sg.type.ledeText')),
          typeSpecimen(t('sg.type.title'), 'sg-demo-h3', t('sg.type.titleText')),
          typeSpecimen(t('sg.type.body'), 'v-body', t('sg.type.bodyText')),
          typeSpecimen(t('sg.type.ui'), 'sg-demo-ui', t('sg.type.uiText')),
          typeSpecimen(t('sg.type.caption'), 'v-caption', t('sg.type.captionText')),
          typeSpecimen(t('sg.type.canon'), 'v-title-canon sg-demo-canon', t('sg.type.canonText')),
        ),
      ),
    )

    page.appendChild(
      section(
        'buttons',
        t('sg.buttons.title'),
        t('sg.buttons.note'),
        ...['primary', 'secondary', 'ghost'].map((v) => stateRow(v, (cls, dis) => Button({ variant: v, class: cls, disabled: dis, iconAfter: v === 'primary' ? 'arrow-right' : undefined }, t('sg.buttons.label')))),
        stateRow(t('sg.buttons.sizes'), (cls, dis) => h('div', { class: 'sg-inline' }, Button({ size: 'sm', class: cls, disabled: dis }, t('sg.buttons.small')), Button({ size: 'lg', class: cls, disabled: dis }, t('sg.buttons.large')))),
        stateRow(t('sg.buttons.withIcon'), (cls, dis) => Button({ variant: 'secondary', icon: 'copy', class: cls, disabled: dis }, t('sg.buttons.copy'))),
        simpleRow(t('sg.buttons.loading'), Button({ loading: true }, t('sg.buttons.sending'))),
        stateRow(t('sg.buttons.iconOnly'), (cls, dis) => h('div', { class: 'sg-inline' }, IconButton({ icon: 'search', label: t('sg.buttons.search'), class: cls, disabled: dis }), IconButton({ icon: 'arrow-right', label: t('sg.buttons.send'), variant: 'solid', class: cls, disabled: dis }))),
      ),
    )

    const levels = Array.from({ length: 13 }, (_, n) => n)
    page.appendChild(
      section(
        'pills',
        t('sg.pills.title'),
        t('sg.pills.note'),
        h('div', { class: 'sg-wrap' }, levels.map((n) => LevelPill({ level: n, text: t('sg.pills.levelText', { n }) }))),
        h('div', { class: 'sg-wrap' }, levels.filter((n) => n % 4 === 0).map((n) => LevelPill({ level: n, size: 'sm' }))),
        stateRow('Tag', (cls, dis) => (dis ? Tag({ variant: 'neutral', class: cls }, t('sg.pills.tagDisabled')) : Tag({ variant: 'outline', class: cls, onClick: () => {} }, t('sg.pills.tag')))),
        stateRow(t('sg.pills.selected'), (cls) => Tag({ selected: true, class: cls, onClick: () => {} }, t('sg.pills.tagSelected'))),
        h('div', { class: 'sg-wrap' }, Tag({}, t('sg.pills.navy')), Tag({ variant: 'outline' }, t('sg.pills.outline')), Tag({ variant: 'neutral' }, t('sg.pills.neutral')), Tag({ variant: 'accent' }, t('sg.pills.accent')), Tag({ variant: 'outline', onRemove: () => {}, removeLabel: t('sg.pills.removeLabel') }, t('sg.pills.removable'))),
      ),
    )

    page.appendChild(
      section(
        'tabs',
        t('sg.tabs.title'),
        t('sg.tabs.note'),
        h('div', { class: 'sg-stack' },
          Tabs({ items: [{ id: 'canon', label: t('sg.tabs.a') }, { id: 'fontes', label: t('sg.tabs.b') }, { id: 'historico', label: t('sg.tabs.c') }], label: t('sg.tabs.title') }),
          Tabs({ variant: 'pill', items: [{ id: 'a', label: t('sg.tabs.d') }, { id: 'b', label: t('sg.tabs.e') }, { id: 'c', label: t('sg.tabs.f') }], label: t('sg.tabs.title') }),
        ),
      ),
    )

    page.appendChild(
      section(
        'fields',
        t('sg.fields.title'),
        t('sg.fields.note'),
        stateRow('Input', (cls, dis) => Input({ label: t('sg.fields.client'), placeholder: t('sg.fields.clientPlaceholder'), disabled: dis, class: cls })),
        simpleRow(t('sg.fields.errorRow'), Input({ label: t('sg.fields.email'), value: 'time@volanos', error: t('sg.fields.emailError') }), Input({ label: t('sg.fields.note2'), hint: t('sg.fields.noteHint') })),
        stateRow('Textarea', (cls, dis) => Input({ label: t('sg.fields.transcript'), multiline: true, rows: 3, disabled: dis, class: cls })),
        stateRow('Select', (cls, dis) => Select({ label: t('sg.fields.level'), options: [{ value: '0', label: t('sg.fields.levelP0') }, { value: '8', label: t('sg.fields.levelP8') }], value: '8', disabled: dis, class: cls })),
        simpleRow('Checkbox', Checkbox({ label: t('sg.fields.directPublish') }), Checkbox({ label: t('sg.fields.checked'), checked: true }), Checkbox({ label: t('sg.fields.disabled'), disabled: true })),
        simpleRow('Switch', Switch({ label: t('sg.fields.off') }), Switch({ label: t('sg.fields.on'), checked: true }), Switch({ label: t('sg.fields.disabled'), disabled: true })),
      ),
    )

    page.appendChild(
      section(
        'cards',
        t('sg.cards.title'),
        t('sg.cards.note'),
        h('div', { class: 'sg-cards' },
          Card({ variant: 'outline' }, h('h3', null, t('sg.cards.outline')), h('p', { class: 'v-caption' }, t('sg.cards.outlineNote'))),
          Card({ variant: 'outline', interactive: true, tabindex: '0' }, h('h3', null, t('sg.cards.interactive')), h('p', { class: 'v-caption' }, t('sg.cards.interactiveNote'))),
          Card({ variant: 'outline', interactive: true, class: 'is-hover' }, h('h3', null, t('sg.cards.hover')), h('p', { class: 'v-caption' }, t('sg.cards.hoverNote'))),
          Card({ variant: 'selected' }, h('h3', null, t('sg.cards.selected')), h('p', { class: 'v-caption' }, t('sg.cards.selectedNote'))),
          Card({ variant: 'navy' }, h('h3', { style: { color: 'var(--white)' } }, t('sg.cards.navy')), h('p', { class: 'v-caption', style: { color: 'var(--grey-eyebrow-dark)' } }, t('sg.cards.navyNote'))),
        ),
      ),
    )

    const dialogBtn = Button({ variant: 'secondary', onClick: () => {
      const d = g.VUI.openDialog({ title: t('sg.feedback.dialogTitle') }, h('p', null, t('sg.feedback.dialogBody')))
      d.el.querySelector('.v-dialog').appendChild(h('div', { class: 'v-dialog__actions' }, Button({ variant: 'ghost', onClick: () => d.close() }, t('sg.feedback.notNow')), Button({ onClick: () => { d.close(); g.VUI.toast(t('sg.feedback.toastText'), { title: t('sg.feedback.toastTitle') }) } }, t('sg.feedback.send'))))
    } }, t('sg.feedback.openDialog'))
    const toastBtn = Button({ variant: 'secondary', onClick: () => g.VUI.toast(t('sg.feedback.toastText2'), { title: t('sg.feedback.toastTitle2'), action: t('sg.feedback.undo'), onAction: () => {} }) }, t('sg.feedback.showToast'))
    page.appendChild(
      section(
        'feedback',
        t('sg.feedback.title'),
        t('sg.feedback.note'),
        h('div', { class: 'sg-wrap' }, dialogBtn, toastBtn, Tooltip({ label: t('sg.feedback.tooltip') }, IconButton({ icon: 'search', label: t('sg.feedback.tooltipLabel') }))),
        h('div', { class: 'sg-stack' }, h('div', { class: 'sg-static' }, g.VUI.Toast({ title: t('sg.feedback.toastTitle'), onClose: () => {} }, t('sg.feedback.toastText'))), h('div', { class: 'sg-static' }, g.VUI.Toast({ variant: 'lead', action: t('sg.feedback.undo'), onAction: () => {} }, t('sg.feedback.toastText2')))),
        h('div', { class: 'sg-static sg-static--dialog' }, g.VUI.Dialog({ title: t('sg.feedback.staticDialog'), actions: [Button({ variant: 'ghost' }, t('sg.feedback.cancel')), Button({}, t('sg.feedback.confirm'))], onClose: () => {} }, h('p', null, t('sg.feedback.staticBody'))).firstElementChild),
      ),
    )
    return page
  }

  async function boot() {
    const root = document.getElementById('sg-root')
    let ok = false
    try {
      const url = localStorage.getItem('sb_url') || window.location.origin
      const token = localStorage.getItem('sb_token')
      if (token) {
        const res = await fetch(`${url}/permissions/me`, { headers: { Authorization: `Bearer ${token}` } })
        const me = res.ok ? await res.json() : null
        ok = !!(me && me.role === 'admin')
      }
    } catch (e) {
      ok = false
    }
    if (!ok) {
      mount(root, h('main', { class: 'sg-denied' }, Logo({ width: 140 }), h('h1', null, t('sg.denied.title')), h('p', { class: 'v-body' }, t('sg.denied.body')), Button({ href: '/' }, t('sg.denied.back'))))
      return
    }
    mount(root, build())
  }

  g.VolanosStyleguide = { build, boot }
})(typeof globalThis !== 'undefined' ? globalThis : window)
