/**
 * Volanos Shared Brain pilot UI: Google sign-in, level texts, invites, the
 * approval queue, the level editor and the model picker.
 *
 * Loaded before app.js so the sign-in fragment is consumed before init() reads
 * localStorage. Everything here talks to the Worker with the same bearer header
 * as the rest of the dashboard; no secret is kept in the page.
 */

/* ── Session fragment ─────────────────────────────────────────────────────── */

let volInviteToken = null
let volWelcomePending = false
;(function consumeLoginFragment() {
  if (typeof window === 'undefined' || !window.location || typeof window.location.hash !== 'string') return
  const raw = window.location.hash.replace(/^#/, '')
  if (!raw) return
  const params = new URLSearchParams(raw)
  const session = params.get('session')
  const invite = params.get('invite')
  if (!session && !invite) return
  try {
    if (session) {
      localStorage.setItem('sb_url', window.location.origin)
      localStorage.setItem('sb_token', session)
      volWelcomePending = params.get('welcome') === '1'
    }
    if (invite) volInviteToken = invite
  } catch (e) {
    /* storage blocked: the sign-in screen will simply show */
  }
  // Remove the secret from the address bar and from history.
  history.replaceState(null, '', window.location.pathname + window.location.search)
})()

/* ── Shared helpers ───────────────────────────────────────────────────────── */

function volHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` }
}

async function volApi(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, { ...options, headers: { ...volHeaders(), ...(options.headers || {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `Erro ${res.status}`)
  return data
}

let volLevels = null
async function volLoadLevels() {
  if (volLevels) return volLevels
  try {
    const data = await volApi('/levels')
    volLevels = data.levels
  } catch (e) {
    volLevels = []
  }
  return volLevels
}

function volLevelText(level) {
  const l = (volLevels || [])[level]
  return l ? `${l.holders}. ${l.reads}. Exemplo: ${l.example}.` : ''
}

/** One-tone pill: the shade lightens from P0 (darkest) to P12, so level never leans on status colors. */
function volPill(level) {
  return `<span class="lvl-pill" data-level="${level}" title="${escAttr(volLevelText(level))}">P${level}</span>`
}

function volLevelOptions(selected) {
  return Array.from({ length: 13 }, (_, n) => {
    const l = (volLevels || [])[n]
    return `<option value="${n}"${selected === n ? ' selected' : ''}>P${n}${l ? ` · ${escHtml(l.holders)}` : ''}</option>`
  }).join('')
}

/** Select in the dashboard's own wrapper so it follows the theme. */
function volSelect(attrs, optionsHtml) {
  return `<span class="team-select-wrap"><select class="team-select" ${attrs}>${optionsHtml}</select><i class="ti ti-chevron-down"></i></span>`
}

function volWhen(ms) {
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

/* ── Sign-in screen: Google button and the invite's level text ────────────── */

async function volInitAuth() {
  const form = document.getElementById('auth-connect')?.closest('form')
  if (!form || document.getElementById('vol-google')) return
  const box = document.createElement('div')
  box.id = 'vol-google'
  box.className = 'vol-google'
  box.innerHTML = `<div id="vol-invite-info" class="vol-invite-info" hidden></div>
    <button type="button" class="vol-google-btn" id="vol-google-btn">Entrar com Google</button>
    <p class="vol-hint">Use o e-mail da Volanos. Contas sem convite ficam pendentes até um administrador aprovar.</p>`
  form.parentNode.insertBefore(box, form)
  document.getElementById('vol-google-btn').addEventListener('click', volStartGoogle)
  if (volInviteToken) {
    try {
      const info = await volPostPublic('/invite/info', { token: volInviteToken })
      const lvl = info.level
      const el = document.getElementById('vol-invite-info')
      el.hidden = false
      el.innerHTML = `<strong>Convite para ${escHtml(info.email)}</strong>
        <div>${volPill(lvl.level)} ${escHtml(lvl.holders)}</div>
        <p>Neste nível você lê: ${escHtml(lvl.reads)}. Exemplo: ${escHtml(lvl.example)}.</p>
        <p>O que for mais restrito que o seu nível vira pedido de aprovação.</p>`
    } catch (e) {
      volInviteToken = null
      showToast('Convite inválido ou expirado')
    }
  }
}

async function volPostPublic(path, body) {
  const res = await fetch(`${window.location.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `Erro ${res.status}`)
  return data
}

async function volStartGoogle() {
  try {
    if (volInviteToken) {
      const { url } = await volPostPublic('/auth/google/start', { invite: volInviteToken })
      window.location.href = url
    } else {
      window.location.href = `${window.location.origin}/auth/google/start`
    }
  } catch (e) {
    showToast(e.message)
  }
}

/* ── Welcome card ─────────────────────────────────────────────────────────── */

async function volShowWelcome() {
  if (!volWelcomePending) return
  volWelcomePending = false
  try {
    const card = await volApi('/welcome')
    await volLoadLevels()
    const dlg = document.createElement('div')
    dlg.className = 'vol-modal'
    dlg.innerHTML = `<div class="vol-modal-card" role="dialog" aria-modal="true" aria-labelledby="vol-welcome-title">
      <h2 id="vol-welcome-title">Bem-vindo ao Shared Brain</h2>
      <p>Seu nível é ${volPill(card.level.level)} <strong>${escHtml(card.level.holders)}</strong>.</p>
      <p>Você lê: ${escHtml(card.reads.map((l) => `P${l.level}`).join(', '))}. Neste nível: ${escHtml(card.level.reads)}.</p>
      <p>${card.approval ? 'Conteúdo mais restrito que o seu nível não é publicado direto: vira um pedido de aprovação para o dono do nível.' : 'Você publica em qualquer nível.'}${card.direct_publish ? ' Você tem publicação direta.' : ''}</p>
      <p>Para usar pelo Claude ou pelo ChatGPT, conecte o MCP neste endereço:</p>
      <code class="vol-code">${escHtml(card.mcp_url)}</code>
      <button type="button" class="digest-btn" id="vol-welcome-ok">Entendi</button>
    </div>`
    document.body.appendChild(dlg)
    dlg.querySelector('#vol-welcome-ok').addEventListener('click', () => dlg.remove())
  } catch (e) {
    /* the card is a courtesy; never block the app on it */
  }
}

/* ── Admin panel ──────────────────────────────────────────────────────────── */

async function loadVolAdmin() {
  const host = document.getElementById('vol-admin')
  if (!host) return
  await volLoadLevels()
  host.innerHTML = `${volAdminTabs('access')}
    <div id="vol-panel-access">
    <section class="vol-section"><div class="digest-section-label">Convidar</div><div id="vol-invite-form"></div><div id="vol-invites"></div></section>
    <section class="vol-section"><div class="digest-section-label">Contas pendentes e publicação direta</div><div id="vol-members"></div></section>
    <section class="vol-section"><div class="digest-section-label">Fila de aprovação</div><div id="vol-queue"></div></section>
    <section class="vol-section"><div class="digest-section-label">Textos dos níveis</div><div id="vol-levels-editor"></div></section>
    </div>
    <div id="vol-panel-health" hidden></div>
    <div id="vol-panel-export" hidden></div>`
  volRenderInviteForm()
  await Promise.all([volRenderInvites(), volRenderMembers(), volRenderQueue('vol-queue'), volRenderLevelsEditor()])
}

function volRenderInviteForm() {
  const el = document.getElementById('vol-invite-form')
  el.innerHTML = `<form class="vol-form" onsubmit="volSubmitInvite(event)">
    <input class="filter-field" id="vol-inv-email" type="email" required placeholder="nome@volanos.ca" autocomplete="off" />
    ${volSelect('id="vol-inv-role"', '<option value="member">Membro</option><option value="admin">Admin</option>')}
    ${volSelect('id="vol-inv-level" onchange="volPreviewLevel()"', volLevelOptions(7))}
    <button class="digest-btn" type="submit">Criar convite</button>
  </form>
  <p class="digest-note" id="vol-inv-preview"></p><div id="vol-inv-link"></div>`
  volPreviewLevel()
}

function volPreviewLevel() {
  const n = Number(document.getElementById('vol-inv-level').value)
  document.getElementById('vol-inv-preview').textContent = `Neste nível a pessoa lê: ${volLevelText(n)}`
}

function volShowLink(link, email) {
  const host = document.getElementById('vol-inv-link')
  host.innerHTML = `<div class="vol-link"><span>Link de ${escHtml(email)}, mostrado uma vez:</span><code>${escHtml(link)}</code>
    <button class="digest-btn" type="button" id="vol-copy-link">Copiar</button></div>`
  document.getElementById('vol-copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); showToast('Link copiado') } catch (e) { showToast('Copie o link manualmente') }
  })
}

async function volSubmitInvite(ev) {
  ev.preventDefault()
  const email = document.getElementById('vol-inv-email').value.trim()
  try {
    const data = await volApi('/team/invites', {
      method: 'POST',
      body: JSON.stringify({ email, role: document.getElementById('vol-inv-role').value, clearance_floor: Number(document.getElementById('vol-inv-level').value) }),
    })
    volShowLink(data.link, email)
    document.getElementById('vol-inv-email').value = ''
    volRenderInvites()
  } catch (e) {
    showToast(e.message)
  }
}

async function volRenderInvites() {
  const el = document.getElementById('vol-invites')
  const { invites } = await volApi('/team/invites')
  if (!invites.length) { el.innerHTML = ''; return }
  el.innerHTML = `<div class="vol-list">${invites.map((i) => `<div class="vol-row">
      <span>${escHtml(i.email)}</span>${volPill(i.clearance_floor)}<span class="vol-muted">${i.role === 'admin' ? 'admin' : 'membro'} · expira ${volWhen(i.expires_at)}</span>
      <button class="digest-btn" type="button" onclick="volResend('${escAttr(i.id)}','${escAttr(i.email)}')">Reenviar</button>
      <button class="digest-btn" type="button" onclick="volCancelInvite('${escAttr(i.id)}')">Cancelar</button></div>`).join('')}</div>`
}

async function volResend(id, email) {
  try { const r = await volApi('/team/invites/resend', { method: 'POST', body: JSON.stringify({ id }) }); volShowLink(r.link, email) } catch (e) { showToast(e.message) }
}
async function volCancelInvite(id) {
  try { await volApi('/team/invites/cancel', { method: 'POST', body: JSON.stringify({ id }) }); volRenderInvites() } catch (e) { showToast(e.message) }
}

async function volRenderMembers() {
  const el = document.getElementById('vol-members')
  const { members } = await volApi('/team/members')
  const pending = members.filter((m) => m.approvalStatus === 'pending')
  const rest = members.filter((m) => m.approvalStatus !== 'pending')
  el.innerHTML = `${pending.length ? `<div class="vol-list">${pending.map((m) => `<div class="vol-row">
      <span>${escHtml(m.name)} · ${escHtml(m.email || '')}</span><span class="vol-muted">aguardando</span>
      ${volSelect(`id="vol-ap-${escAttr(m.userId)}"`, volLevelOptions(12))}
      <button class="digest-btn" type="button" onclick="volApprove('${escAttr(m.userId)}')">Aprovar</button></div>`).join('')}</div>` : '<p class="digest-note">Nenhuma conta aguardando.</p>'}
    <div class="vol-list">${rest.map((m) => `<label class="vol-row"><span>${escHtml(m.name)}</span>${volPill(m.clearanceFloor)}
      <span class="vol-muted">publicação direta</span>
      <input type="checkbox" style="accent-color: var(--accent)" ${m.directPublish ? 'checked' : ''} onchange="volDirectPublish('${escAttr(m.userId)}', this.checked)" /></label>`).join('')}</div>`
}

async function volApprove(id) {
  try {
    await volApi('/team/members/approve', { method: 'POST', body: JSON.stringify({ id, clearance_floor: Number(document.getElementById(`vol-ap-${id}`).value) }) })
    showToast('Conta aprovada')
    volRenderMembers()
  } catch (e) { showToast(e.message) }
}
async function volDirectPublish(id, on) {
  try { await volApi('/team/members/direct-publish', { method: 'POST', body: JSON.stringify({ id, direct_publish: on }) }) } catch (e) { showToast(e.message); volRenderMembers() }
}

/** Approval queue. Shown to anyone who owns a level, not only admins. */
async function volRenderQueue(hostId) {
  const el = document.getElementById(hostId)
  if (!el) return
  await volLoadLevels()
  const { contributions } = await volApi('/contributions?status=pending')
  if (!contributions.length) { el.innerHTML = '<p class="digest-note">Nada esperando aprovação.</p>'; return }
  el.innerHTML = contributions.map((c) => {
    const conf = c.confidence == null ? 'sem confiança' : `${Math.round(c.confidence * 100)}%`
    return `<article class="vol-card" id="vol-c-${escAttr(c.id)}">
      <header>${volPill(c.suggested_level)} <span class="vol-muted">confiança ${conf} · ${escHtml(c.source_path || c.source || '')}</span></header>
      <textarea class="filter-field" rows="3" id="vol-ct-${escAttr(c.id)}">${escHtml(c.content)}</textarea>
      <footer>${volSelect(`id="vol-cl-${escAttr(c.id)}"`, volLevelOptions(c.suggested_level))}
      <button class="digest-btn" type="button" onclick="volResolve('${escAttr(c.id)}','approve','${hostId}')">Aprovar</button>
      <button class="digest-btn" type="button" onclick="volResolve('${escAttr(c.id)}','reject','${hostId}')">Rejeitar</button></footer></article>`
  }).join('')
}

async function volResolve(id, action, hostId) {
  try {
    const body = { id, action }
    if (action === 'approve') {
      body.level = Number(document.getElementById(`vol-cl-${id}`).value)
      body.content = document.getElementById(`vol-ct-${id}`).value
    }
    await volApi('/contributions/resolve', { method: 'POST', body: JSON.stringify(body) })
    showToast(action === 'approve' ? 'Publicado' : 'Rejeitado')
    volRenderQueue(hostId)
  } catch (e) { showToast(e.message) }
}

async function volRenderLevelsEditor() {
  const el = document.getElementById('vol-levels-editor')
  el.innerHTML = `<p class="digest-note">O mesmo texto aparece nas telas e vai para o Jev como rubrica.</p>
    <div class="vol-levels">${volLevels.map((l) => `<div class="vol-level-row" data-level="${l.level}">${volPill(l.level)}
      <input class="filter-field" data-f="holders" value="${escAttr(l.holders)}" aria-label="Quem tem P${l.level}" />
      <input class="filter-field" data-f="reads" value="${escAttr(l.reads)}" aria-label="O que lê P${l.level}" />
      <input class="filter-field" data-f="example" value="${escAttr(l.example)}" aria-label="Exemplo P${l.level}" /></div>`).join('')}</div>
    <button class="digest-btn" type="button" onclick="volSaveLevels()">Salvar textos</button>`
}

async function volSaveLevels() {
  const rows = [...document.querySelectorAll('#vol-levels-editor .vol-level-row')].map((row) => ({
    level: Number(row.dataset.level),
    holders: row.querySelector('[data-f=holders]').value,
    reads: row.querySelector('[data-f=reads]').value,
    example: row.querySelector('[data-f=example]').value,
  }))
  try {
    const data = await volApi('/levels', { method: 'PUT', body: JSON.stringify({ levels: rows }) })
    volLevels = data.levels
    showToast('Textos salvos')
  } catch (e) { showToast(e.message) }
}

/** Approvers who are not admins still need the queue; mount it in their team view. */
async function volMountMemberQueue() {
  const view = document.getElementById('team-member-view')
  if (!view || document.getElementById('vol-member-queue')) return
  const holder = document.createElement('section')
  holder.className = 'vol-section'
  holder.innerHTML = '<div class="digest-section-label">Pedidos de aprovação</div><div id="vol-member-queue"></div>'
  view.appendChild(holder)
  try { await volRenderQueue('vol-member-queue') } catch (e) { holder.remove() }
}

/* ── Model picker (chat) ──────────────────────────────────────────────────── */

const VOL_MODEL_KEY = 'sb_llm_choice'
let volModels = []

function volChoice() {
  try { return JSON.parse(localStorage.getItem(VOL_MODEL_KEY) || 'null') } catch (e) { return null }
}

async function volInitModelPicker() {
  const input = document.getElementById('recall-input')
  if (!input || document.getElementById('vol-model-picker')) return
  try {
    const data = await volApi('/llm/models')
    volModels = data.models
  } catch (e) { return }
  if (volModels.length < 2) return
  const wrap = document.createElement('label')
  wrap.className = 'vol-model-wrap'
  const saved = volChoice()
  const current = saved ? `${saved.provider}|${saved.model}` : ''
  wrap.innerHTML = `<span class="vol-muted">Modelo</span><span class="team-select-wrap"><select id="vol-model-picker" class="team-select" aria-label="Provedor e modelo">
    <option value="">Padrão da Volanos</option>
    ${volModels.map((m) => `<option value="${escAttr(`${m.provider}|${m.id}`)}"${current === `${m.provider}|${m.id}` ? ' selected' : ''}>${escHtml(m.label)}</option>`).join('')}</select><i class="ti ti-chevron-down"></i></span>`
  input.parentNode.insertBefore(wrap, input)
  wrap.querySelector('select').addEventListener('change', (e) => {
    try {
      if (!e.target.value) localStorage.removeItem(VOL_MODEL_KEY)
      else { const [provider, ...rest] = e.target.value.split('|'); localStorage.setItem(VOL_MODEL_KEY, JSON.stringify({ provider, model: rest.join('|') })) }
    } catch (err) { /* choice just won't persist */ }
  })
}

/** Fields appended to the /chat body: the picked model and the ids that set the privacy floor. */
function volChatExtras(results) {
  const c = volChoice()
  return { memory_ids: results.map((m) => m.id), ...(c ? { provider: c.provider, model: c.model } : {}) }
}

/** Called by recall.js when the first SSE event says which model answered. */
function volShowAnsweredBy(meta, answerEl) {
  if (!meta || !answerEl) return
  const tag = document.createElement('div')
  tag.className = 'vol-answered-by'
  tag.textContent = `${meta.fallback ? 'Modelo reserva' : 'Modelo'}: ${meta.provider} · ${meta.model}`
  answerEl.parentNode.appendChild(tag)
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', () => {
    volInitAuth()
  })
}

/** Called from showApp() in auth.js once the app is on screen. */
function volAfterShowApp() {
  volLoadLevels().then(() => { volInitModelPicker(); volShowWelcome() })
}
