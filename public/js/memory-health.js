/**
 * Admin tabs "Saúde da memória" and "Exportação" (Volanos Shared Brain).
 *
 * Loaded after volanos.js and relies on its helpers: volApi, volPill, volWhen,
 * escHtml, escAttr, showToast. Both tabs are admin-only on the server too.
 */

const VOL_AGING_JOBS = [
  { job: 'dedup', key: 'AGING_DEDUP', label: 'Quase-duplicatas', hint: 'Semanal. Pares com 95% ou mais de similaridade, no mesmo workspace e nível, viram sugestão de fusão. Nada é mesclado sozinho.' },
  { job: 'contradictions', key: 'AGING_CONTRADICTIONS', label: 'Contradições', hint: 'Semanal, sem IA. Mesmo assunto com números, datas ou valores diferentes gera um alerta. Quem decide é o autor da memória canônica.' },
  { job: 'compact', key: 'AGING_COMPACT', label: 'Compactação de notas frias', hint: 'Semanal. Notas episódicas sem acesso há muito tempo ganham um resumo extrativo; o original fica no histórico e pode ser restaurado.' },
]

/* ── Tabs ─────────────────────────────────────────────────────────────────── */

function volAdminTabs(active) {
  return `<div class="vol-tabs" role="tablist" aria-label="Seções do painel admin">${[
    ['access', 'Acesso'], ['health', 'Saúde da memória'], ['export', 'Exportação'],
  ].map(([id, label]) => `<button class="vol-tab${id === active ? ' active' : ''}" id="vol-tab-${id}" role="tab" aria-selected="${id === active}" type="button" onclick="volAdminTab('${id}')">${label}</button>`).join('')}</div>`
}

async function volAdminTab(id) {
  for (const t of ['access', 'health', 'export']) {
    const panel = document.getElementById(`vol-panel-${t}`)
    const tab = document.getElementById(`vol-tab-${t}`)
    if (panel) panel.hidden = t !== id
    if (tab) { tab.classList.toggle('active', t === id); tab.setAttribute('aria-selected', String(t === id)) }
  }
  if (id === 'health') await volRenderHealth()
  if (id === 'export') await volRenderExport()
}

/* ── Saúde da memória ─────────────────────────────────────────────────────── */

function volStat(n, label) {
  return `<div class="vol-stat"><strong>${escHtml(String(n))}</strong><span>${escHtml(label)}</span></div>`
}

async function volRenderHealth() {
  const el = document.getElementById('vol-panel-health')
  if (!el) return
  el.innerHTML = '<p class="digest-note">Carregando…</p>'
  try {
    const [h, dup, con] = await Promise.all([
      volApi('/admin/memory-health'),
      volApi('/memory/suggestions?kind=duplicate'),
      volApi('/memory/suggestions?kind=contradiction'),
    ])
    const s = h.health
    el.innerHTML = `
      <section class="vol-section"><div class="digest-section-label">Resumo</div>
        <div class="vol-stats">
          ${volStat(s.duplicates_open, 'duplicatas sugeridas')}${volStat(s.contradictions_open, 'contradições abertas')}
          ${volStat(s.cold_memories, `memórias frias (${h.cold_days}+ dias)`)}${volStat(s.compactable_notes, 'notas compactáveis')}
          ${volStat(s.compacted, 'compactadas')}${volStat(s.superseded, 'substituídas')}${volStat(s.archived, 'arquivadas')}
        </div>
      </section>
      <section class="vol-section"><div class="digest-section-label">Rotinas semanais</div>
        <div class="vol-list">${VOL_AGING_JOBS.map((j) => volAgingRow(j, h.flags[j.job])).join('')}</div>
        <p class="digest-note">Todas desligadas por padrão. Cada passagem lê um lote por vez e continua de onde parou. Toda ação automática fica no registro de auditoria como <code>system:aging-…</code>.</p>
      </section>
      <section class="vol-section"><div class="digest-section-label">Duplicatas para decidir</div><div id="vol-sug-duplicate" class="vol-list">${volSuggestions(dup.suggestions)}</div></section>
      <section class="vol-section"><div class="digest-section-label">Contradições abertas</div><div id="vol-sug-contradiction" class="vol-list">${volSuggestions(con.suggestions)}</div></section>
      <section class="vol-section"><div class="digest-section-label">Mais usadas</div>${s.most_used.length
        ? `<div class="vol-list">${s.most_used.map((m) => `<div class="vol-row"><span>${escHtml(m.title)}</span><span class="vol-muted">${m.access_count} acessos</span></div>`).join('')}</div>`
        : '<p class="digest-note">Ainda não há acessos registrados.</p>'}</section>
      <section class="vol-section"><div class="digest-section-label">Últimas rotinas</div>${volJobList(h.jobs)}</section>`
  } catch (e) {
    el.innerHTML = `<div class="vol-card vol-card--error"><p>${escHtml(e.message)}</p></div>`
  }
}

function volAgingRow(j, on) {
  return `<div class="vol-row"><span>${escHtml(j.label)}<br><span class="vol-muted">${escHtml(j.hint)}</span></span>
    <span class="vol-muted">${on ? 'ligada' : 'desligada'}</span>
    <button class="digest-btn" type="button" onclick="volSetAging('${j.key}', ${on ? 'false' : 'true'})">${on ? 'Desligar' : 'Ligar'}</button>
    <button class="digest-btn" type="button" ${on ? '' : 'disabled'} onclick="volRunAging('${j.job}')">Rodar agora</button></div>`
}

async function volSetAging(key, on) {
  try {
    await volApi('/config', { method: 'PATCH', body: JSON.stringify({ [key]: on ? 'on' : 'off' }) })
    showToast(on ? 'Rotina ligada' : 'Rotina desligada')
    volRenderHealth()
  } catch (e) { showToast(e.message) }
}

async function volRunAging(job) {
  try {
    const r = await volApi('/admin/aging/run', { method: 'POST', body: JSON.stringify({ job }) })
    showToast(`Lote concluído: ${r.scanned} lidas, ${r.created} novas`)
    volRenderHealth()
  } catch (e) { showToast(e.message) }
}

function volJobList(jobs) {
  if (!jobs.length) return '<p class="digest-note">Nenhuma rotina rodou ainda.</p>'
  return `<div class="vol-list">${jobs.map((j) => {
    const sum = j.summary || {}
    const detail = j.job === 'export'
      ? (sum.message || sum.reason || sum.error || '')
      : [sum.scanned != null ? `${sum.scanned} lidas` : '', sum.created != null ? `${sum.created} novas` : '', sum.error || ''].filter(Boolean).join(' · ')
    return `<div class="vol-row${j.ok ? '' : ' vol-error'}"><span>${escHtml(j.job)}</span><span class="vol-muted">${volWhen(j.started_at)}</span>
      <span class="vol-muted">${escHtml(detail)}</span><span class="vol-muted">${escHtml(j.actor_id || '')}</span></div>`
  }).join('')}</div>`
}

function volSuggestions(list) {
  if (!list.length) return '<p class="digest-note">Nada pendente.</p>'
  return list.map((s) => {
    const side = (x, tag) => `<div class="vol-side"><div class="vol-row"><strong>${escHtml(x.title)}</strong>${volPill(x.clearance_level)}${x.canonical ? '<span class="vol-muted">canônica</span>' : ''}</div>
      <p class="vol-excerpt">${escHtml(x.excerpt)}</p><span class="vol-muted">${tag} · ${escHtml(x.source || '')} · v${x.version} · ${volWhen(x.updated_at)}</span></div>`
    const d = s.detail || {}
    const divergences = (d.divergences || []).map((v) => `<div class="vol-diverge"><span>${escHtml((v.aValues || []).join(', '))}</span> × <span>${escHtml((v.bValues || []).join(', '))}</span></div>`).join('')
    const prec = d.precedence && d.precedence.winner ? `<p class="vol-muted">Pela precedência (${escHtml(d.precedence.rule)}), tende a valer ${escHtml(d.precedence.winner === s.a.id ? 'A' : 'B')}. Quantidade de memórias que repetem um valor nunca troca a canônica.</p>` : ''
    return `<div class="vol-card" id="vol-sug-${escAttr(s.id)}">
      <header><strong>${s.kind === 'duplicate' ? 'Quase duplicadas' : 'Valores divergentes'}</strong><span class="vol-muted">similaridade ${Math.round((s.score || 0) * 100)}%</span></header>
      ${divergences}${prec}
      <div class="vol-sides">${side(s.a, 'A')}${side(s.b, 'B')}</div>
      <footer>
        <button class="digest-btn" type="button" onclick="volResolveSuggestion('${escAttr(s.id)}','merge','${escAttr(s.a.id)}')">Manter A, substituir B</button>
        <button class="digest-btn" type="button" onclick="volResolveSuggestion('${escAttr(s.id)}','merge','${escAttr(s.b.id)}')">Manter B, substituir A</button>
        <button class="digest-btn" type="button" onclick="volResolveSuggestion('${escAttr(s.id)}','dismiss')">Ignorar</button>
      </footer></div>`
  }).join('')
}

async function volResolveSuggestion(id, action, keep) {
  try {
    await volApi('/memory/suggestions/resolve', { method: 'POST', body: JSON.stringify({ id, action, keep }) })
    showToast(action === 'merge' ? 'Substituída. O texto antigo continua no histórico.' : 'Sugestão ignorada')
    volRenderHealth()
  } catch (e) { showToast(e.message) }
}

/* ── Exportação ───────────────────────────────────────────────────────────── */

async function volRenderExport() {
  const el = document.getElementById('vol-panel-export')
  if (!el) return
  el.innerHTML = '<p class="digest-note">Carregando…</p>'
  try {
    const [st, cfg] = await Promise.all([volApi('/admin/export/status'), volApi('/config')])
    el.innerHTML = `
      <section class="vol-section">
        <div class="vol-card vol-card--notice"><header><i class="ti ti-lock"></i><strong>O repositório de exportação contém P0</strong></header>
          <p>Todos os níveis são exportados, inclusive os mais restritos, para que o banco possa ser reconstruído só com esses arquivos. Quem lê o repositório lê tudo: <strong>o acesso a ele equivale a P0 e deve ficar restrito ao dono e ao admin técnico.</strong> Use um repositório privado e um token com permissão apenas nele.</p></div>
      </section>
      <section class="vol-section"><div class="digest-section-label">Destino</div>
        <form class="vol-form" onsubmit="volSaveExportTarget(event)">
          <input class="filter-field" id="vol-exp-repo" placeholder="dono/repositorio" value="${escAttr(cfg.config.EXPORT_REPO || '')}" autocomplete="off" />
          <input class="filter-field" id="vol-exp-branch" placeholder="main" value="${escAttr(cfg.config.EXPORT_BRANCH || 'main')}" autocomplete="off" style="flex: 0 1 120px" />
          <button class="digest-btn" type="submit">Salvar</button>
        </form>
        <p class="digest-note">${st.token_configured ? 'Token <code>GITHUB_EXPORT_TOKEN</code> configurado.' : 'Falta o secret <code>GITHUB_EXPORT_TOKEN</code> do Worker (permissão Contents, leitura e escrita, só neste repositório).'}
          ${st.enabled ? 'Exportação ligada.' : 'Exportação desligada até haver repositório e token.'} Automática: ${escHtml(st.schedule)}.</p>
      </section>
      <section class="vol-section"><div class="digest-section-label">Exportar</div>
        <div class="vol-row"><span>${st.last_run_at ? `Última execução ${volWhen(st.last_run_at)}${st.last_message ? ` · ${escHtml(st.last_message)}` : ''}` : 'Ainda não exportou.'}</span>
          <button class="digest-btn" type="button" id="vol-export-now" ${st.enabled ? '' : 'disabled'} onclick="volExportNow()">Exportar agora</button></div>
        <div id="vol-export-result"></div>
        ${volJobList(st.runs)}
      </section>
      <section class="vol-section"><div class="digest-section-label">Reconstruir a partir da exportação</div>
        <p class="digest-note">Recria memórias, níveis, diretórios e versões a partir dos arquivos. Seguro para repetir: o que já existe e é mais novo não é alterado. Contas e permissões de pasta não vão nos arquivos; recrie-as no app. Os vetores de busca são refeitos depois (<code>/vectorize-pending</code>).</p>
        <div class="vol-row">
          <button class="digest-btn" type="button" ${st.enabled ? '' : 'disabled'} onclick="volRebuild(true)">Simular</button>
          <button class="digest-btn" type="button" ${st.enabled ? '' : 'disabled'} onclick="volRebuildConfirm()">Reconstruir</button>
        </div>
        <div id="vol-rebuild-result"></div>
      </section>`
  } catch (e) {
    el.innerHTML = `<div class="vol-card vol-card--error"><p>${escHtml(e.message)}</p></div>`
  }
}

async function volSaveExportTarget(ev) {
  ev.preventDefault()
  const repo = document.getElementById('vol-exp-repo').value.trim()
  const branch = document.getElementById('vol-exp-branch').value.trim() || 'main'
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { showToast('Use o formato dono/repositorio'); return }
  try {
    await volApi('/config', { method: 'PATCH', body: JSON.stringify({ EXPORT_REPO: repo, EXPORT_BRANCH: branch }) })
    showToast('Destino salvo')
    volRenderExport()
  } catch (e) { showToast(e.message) }
}

async function volExportNow() {
  const btn = document.getElementById('vol-export-now')
  const out = document.getElementById('vol-export-result')
  if (btn) btn.disabled = true
  if (out) out.innerHTML = '<p class="digest-note">Exportando…</p>'
  try {
    const r = await volApi('/admin/export-now', { method: 'POST', body: '{}' })
    if (out) out.innerHTML = `<p class="digest-note">${escHtml(r.message || 'Nada novo para exportar.')}${r.commit ? ` · commit <code>${escHtml(String(r.commit).slice(0, 7))}</code>` : ''}${r.more ? ' · ainda há memórias na fila; exporte de novo.' : ''}</p>`
    volRenderExport()
  } catch (e) {
    if (out) out.innerHTML = `<div class="vol-card vol-card--error"><p>${escHtml(e.message)}</p></div>`
    if (btn) btn.disabled = false
  }
}

function volRebuildConfirm() {
  openDangerConfirm({
    title: 'Reconstruir a partir da exportação?',
    body: 'Grava memórias, versões e diretórios no banco a partir do repositório. O que já existe e é mais novo é mantido. Rode antes uma simulação.',
    confirmLabel: 'Reconstruir',
    onConfirm: async (_checked, done) => { try { await volRebuild(false) } finally { done() } },
  })
}

async function volRebuild(dry) {
  const out = document.getElementById('vol-rebuild-result')
  const total = { entries_created: 0, entries_updated: 0, entries_unchanged: 0, entries_kept_newer: 0, versions_created: 0, errors: [], skipped: 0 }
  let offset = 0
  let last = null
  try {
    for (let guard = 0; guard < 500; guard++) {
      if (out) out.innerHTML = `<p class="digest-note">${dry ? 'Simulando' : 'Reconstruindo'}… ${offset} arquivos</p>`
      const r = await volApi('/admin/rebuild-from-export', { method: 'POST', body: JSON.stringify({ dry_run: dry, offset, limit: 40 }) })
      for (const k of ['entries_created', 'entries_updated', 'entries_unchanged', 'entries_kept_newer', 'versions_created']) total[k] += r[k] || 0
      total.errors.push(...(r.errors || []))
      total.skipped += (r.skipped_files || []).length
      last = r
      if (r.next_offset == null) break
      offset = r.next_offset
    }
    if (out) out.innerHTML = `<div class="vol-card"><p><strong>${dry ? 'Simulação' : 'Reconstrução'}:</strong> ${total.entries_created} memórias novas, ${total.entries_updated} atualizadas, ${total.entries_unchanged} iguais, ${total.entries_kept_newer} mantidas por serem mais novas, ${total.versions_created} versões. ${total.skipped} arquivos ignorados.${total.errors.length ? ` ${total.errors.length} com erro.` : ''}${last && last.pending_embeddings ? ` ${last.pending_embeddings} aguardam vetores.` : ''}</p></div>`
  } catch (e) {
    if (out) out.innerHTML = `<div class="vol-card vol-card--error"><p>${escHtml(e.message)}</p></div>`
  }
}
