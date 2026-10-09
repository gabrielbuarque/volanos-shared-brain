/**
 * Entrada e boas-vindas. Único lugar, junto com a primeira boas-vindas, com o gradiente navy.
 * Login com Google (convite opcional) e, recolhido, o token do dono ou de quem recebeu um token.
 */
;(function (g) {
  const { h, mount, Button, Input, Logo, Statement, Eyebrow, LevelPill } = g.VUI

  async function postPublic(path, body) {
    const res = await fetch(`${window.location.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  async function inviteCard(invite, host) {
    try {
      const info = await postPublic('/invite/info', { token: invite })
      const lvl = info.level
      mount(host,
        h('div', { class: 'login__invite' },
          h('p', null, t('login.inviteFor', { email: info.email })),
          h('div', { class: 'login__invite-level' }, LevelPill({ level: lvl.level }), h('span', null, lvl.holders)),
          h('p', { class: 'v-caption' }, t('login.inviteReads', { reads: lvl.reads })),
          h('p', { class: 'v-caption' }, t('login.inviteApproval')),
        ))
    } catch (e) {
      mount(host, h('p', { class: 'v-caption' }, t('login.inviteInvalid')))
    }
  }

  async function startGoogle(invite, errorHost) {
    try {
      if (invite) {
        const { url } = await postPublic('/auth/google/start', { invite })
        window.location.href = url
      } else {
        window.location.href = `${window.location.origin}/auth/google/start`
      }
    } catch (e) {
      mount(errorHost, h('p', { class: 'login__error', role: 'alert' }, t('login.googleUnavailable')))
    }
  }

  /** `reason`: código de sessão encerrada (suspended, removed, invalid_token) ou vazio. */
  function render(host, { reason, invite, onSignedIn } = {}) {
    const errorHost = h('div', { 'aria-live': 'polite' })
    const inviteHost = h('div')
    const tokenInput = g.VUI.Input({ label: t('login.token'), type: 'password', autocomplete: 'current-password', placeholder: t('login.tokenPlaceholder') })
    const form = h('form', { class: 'login__token', onSubmit: async (e) => {
      e.preventDefault()
      const token = tokenInput.control.value.trim()
      if (!token) { mount(errorHost, h('p', { class: 'login__error', role: 'alert' }, t('login.fillToken'))); return }
      try {
        await g.Session.signIn(window.location.origin, token)
        g.Session.ended = null
        onSignedIn()
      } catch (err) {
        const code = err && err.code
        mount(errorHost, h('p', { class: 'login__error', role: 'alert' }, t(code === 'suspended' ? 'login.suspended' : code === 'removed' ? 'login.removed' : 'login.invalidToken')))
      }
    } }, tokenInput, Button({ type: 'submit', variant: 'secondary' }, t('login.connect')))
    if (reason) mount(errorHost, h('p', { class: 'login__error', role: 'alert' }, t(reason === 'suspended' ? 'login.suspended' : reason === 'removed' ? 'login.removed' : 'login.expired')))
    mount(host,
      h('main', { class: 'login v-inverse' },
        h('div', { class: 'login__panel' },
          Logo({ tone: 'white', width: 160 }),
          h('div', { class: 'login__copy' },
            Eyebrow({}, t('login.eyebrow')),
            Statement({ turn: t('login.turn'), support: t('login.support') }, t('login.statement')),
          ),
          inviteHost,
          Button({ size: 'lg', onClick: () => startGoogle(invite, errorHost) }, t('login.google')),
          h('p', { class: 'v-caption' }, t('login.hint')),
          errorHost,
          h('details', { class: 'login__more' }, h('summary', null, t('login.withToken')), form),
        ),
      ),
    )
    if (invite) inviteCard(invite, inviteHost)
  }

  /** Boas-vindas na primeira entrada: nível, o que lê e o endereço do MCP. */
  async function welcome() {
    try {
      const card = await g.Session.api('/welcome')
      const levelNames = card.reads.map((l) => `P${l.level}`).join(', ')
      const d = g.VUI.openDialog({ title: t('welcome.title'), class: 'v-inverse welcome' },
        h('p', null, t('welcome.level'), ' ', LevelPill({ level: card.level.level }), ' ', h('strong', null, card.level.holders)),
        h('p', null, t('welcome.reads', { levels: levelNames, reads: card.level.reads })),
        h('p', null, card.approval ? t('welcome.approval') : t('welcome.anyLevel')),
        h('p', null, t('welcome.mcp')),
        h('code', null, card.mcp_url),
        h('div', { class: 'v-dialog__actions' }, Button({ onClick: () => d.close() }, t('welcome.ok'))),
      )
    } catch (e) {
      /* a boas-vindas é cortesia: nunca bloqueia o app */
    }
  }

  g.LoginScreen = { render, welcome }
})(typeof globalThis !== 'undefined' ? globalThis : window)
