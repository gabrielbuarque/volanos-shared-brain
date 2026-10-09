/**
 * Grafo: as memórias agrupadas por tema e ligadas por conexão. Layout estático (empacotamento de círculos), sem simulação.
 * Marca: sem cor por grupo. Nó cheio navy; compartilhado leva anel; grupo é um círculo com rótulo; ligação explícita é
 * linha cheia e automática é tracejada. Zoom por botões, roda e pinça; toque abre a memória.
 */
;(function (g) {
  const { h, mount, Button, Select } = g.VUI
  const { Parts, App, Session, Legacy } = g

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const LOOSE = '__loose__'
  let layer = ''

  async function openNode(node, onChanged) {
    try {
      const { entry } = await Session.api('/entry?id=' + encodeURIComponent(node.id))
      g.MemoryUI.open(entry, { onChanged })
    } catch (e) {
      g.MemoryUI.open({ id: node.id, content: node.label, tags: node.tags || [] }, { onChanged })
    }
  }

  function simulate(canvas, nodes, edges, onOpen) {
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const W = rect.width || 600
    const H = rect.height || 420
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    const ink = cssVar('--volanos-blue')
    const muted = cssVar('--text-secondary')
    const paper = cssVar('--off-white')
    const hair = cssVar('--lead-grey')
    const byId = {}
    nodes.forEach((n) => { byId[n.id] = n })
    const links = edges.map((e) => ({ s: byId[e.source], t: byId[e.target], w: e.weight, p: e.provenance })).filter((l) => l.s && l.t)
    Legacy.assignGraphClusters(nodes, edges)

    const NODE_R = 9, GAP_SUB = 7, GAP_OUT = 24
    const clusterList = []
    const subList = []
    const byOuter = new Map()
    for (const n of nodes) { if (!byOuter.has(n.cluster)) byOuter.set(n.cluster, []); byOuter.get(n.cluster).push(n) }
    const outer = []
    for (const [id, members] of byOuter) {
      const bySub = new Map()
      const loose = []
      for (const n of members) { if (!n.sub) { loose.push(n); continue } if (!bySub.has(n.sub)) bySub.set(n.sub, []); bySub.get(n.sub).push(n) }
      const subs = []
      for (const [tag, sm] of bySub) {
        const spread = sm.length <= 1 ? 0 : 7 + 8 * Math.sqrt(sm.length)
        const local = Legacy.packGraphNodes(sm.length, spread)
        sm.forEach((n, i) => { n.slx = local[i].x; n.sly = local[i].y })
        subs.push({ tag, members: sm, ringR: spread + NODE_R + 3 })
      }
      const packed = Legacy.packGraphCircles([...subs.map((s) => s.ringR), ...loose.map(() => NODE_R + 4)], GAP_SUB)
      subs.forEach((s, i) => { s.cx = packed.centers[i].x; s.cy = packed.centers[i].y })
      loose.forEach((n, i) => { const c = packed.centers[subs.length + i]; n.olx = c.x; n.oly = c.y })
      outer.push({ id, subs, loose, R: packed.R + 9 })
    }
    const outerPacked = Legacy.packGraphCircles(outer.map((o) => o.R), GAP_OUT)
    outer.forEach((o, i) => { o.cx = outerPacked.centers[i].x; o.cy = outerPacked.centers[i].y })
    for (const o of outer) {
      if (o.id !== LOOSE) clusterList.push({ label: o.id, cx: o.cx, cy: o.cy, R: o.R })
      for (const s of o.subs) {
        const scx = o.cx + s.cx, scy = o.cy + s.cy
        subList.push({ label: s.tag, cx: scx, cy: scy, R: s.ringR })
        for (const n of s.members) { n.x = scx + n.slx; n.y = scy + n.sly }
      }
      for (const n of o.loose) { n.x = o.cx + n.olx; n.y = o.cy + n.oly }
    }

    const cam = { x: 0, y: 0, scale: 1 }
    const pointers = new Map()
    const st = { hover: null, pressNode: null, panning: false, panStart: null, moved: false, downId: null, pinch: null }
    const SHOW_LABELS = nodes.length <= 50
    const radius = (n) => 5 + Math.min(6, n.importance || 0)
    const local = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top } }
    const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale })
    const clamp = (s) => Math.max(0.05, Math.min(4, s))
    function nodeAt(sx, sy) {
      const w = toWorld(sx, sy)
      const tol = 18 / cam.scale
      let best = null, bestD = tol * tol
      for (const n of nodes) { const dx = n.x - w.x, dy = n.y - w.y, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = n } }
      return best
    }
    function zoomAround(sx, sy, f) { const ns = clamp(cam.scale * f); cam.x = sx - (sx - cam.x) * (ns / cam.scale); cam.y = sy - (sy - cam.y) * (ns / cam.scale); cam.scale = ns; draw() }
    function fit() {
      if (!nodes.length) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y) }
      const pad = 70
      const gw = maxX - minX || 1, gh = maxY - minY || 1
      cam.scale = clamp(Math.min((W - pad) / gw, (H - pad) / gh, 1.4))
      cam.x = W / 2 - ((minX + maxX) / 2) * cam.scale
      cam.y = H / 2 - ((minY + maxY) / 2) * cam.scale
      draw()
    }
    const short = (n) => { const x = (n.label || '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim(); return x.length > 18 ? x.slice(0, 18).trimEnd() + '…' : x }
    function pill(text, cx, top, strong) {
      ctx.font = `${strong ? '600 ' : ''}11px Montserrat, sans-serif`
      const tw = ctx.measureText(text).width
      const x = cx - tw / 2 - 5
      ctx.fillStyle = paper
      ctx.fillRect(x, top, tw + 10, 16)
      ctx.fillStyle = strong ? ink : muted
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, cx, top + 8)
    }
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y)
      const hover = st.hover
      ctx.strokeStyle = ink
      for (const c of clusterList) { ctx.globalAlpha = 0.5; ctx.lineWidth = 1.25 / cam.scale; ctx.setLineDash([]); ctx.beginPath(); ctx.arc(c.cx, c.cy, c.R, 0, Math.PI * 2); ctx.stroke() }
      ctx.globalAlpha = 0.35
      ctx.setLineDash([4 / cam.scale, 4 / cam.scale])
      for (const s of subList) { ctx.lineWidth = 1 / cam.scale; ctx.beginPath(); ctx.arc(s.cx, s.cy, s.R, 0, Math.PI * 2); ctx.stroke() }
      ctx.globalAlpha = 1
      for (const l of links) {
        const lit = hover && (l.s === hover || l.t === hover)
        ctx.setLineDash(l.p === 'explicit' ? [] : l.p === 'system' ? [1 / cam.scale, 2 / cam.scale] : [3 / cam.scale, 3 / cam.scale])
        ctx.globalAlpha = lit ? 0.9 : 0.25
        ctx.strokeStyle = ink
        ctx.lineWidth = lit ? Math.max(1.5, l.w * 2.5) : Math.max(0.5, l.w * 1.5)
        ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke()
      }
      ctx.setLineDash([])
      for (const n of nodes) {
        const r = radius(n)
        ctx.globalAlpha = n.status === 'deprecated' ? 0.4 : 1
        ctx.fillStyle = n.cluster === LOOSE ? muted : ink
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill()
        if (n.workspace === 'company') { ctx.globalAlpha = 0.8; ctx.strokeStyle = ink; ctx.lineWidth = 1.5 / cam.scale; ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.5, 0, Math.PI * 2); ctx.stroke() }
        if (n === hover) { ctx.globalAlpha = 1; ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2); ctx.stroke() }
      }
      ctx.globalAlpha = 1
      if (SHOW_LABELS && cam.scale >= 0.5) for (const n of nodes) if (n !== hover) pill(short(n), n.x, n.y + radius(n) + 4, false)
      if (cam.scale >= 0.12) {
        const k = 1 / cam.scale
        ctx.font = `700 ${13 * k}px Montserrat, sans-serif`
        for (const c of clusterList) { const tw = ctx.measureText(c.label).width; if (tw + 14 * k > c.R * 2 * 1.6) continue; ctx.fillStyle = paper; ctx.fillRect(c.cx - tw / 2 - 7 * k, c.cy - c.R - 26 * k, tw + 14 * k, 20 * k); ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(c.label, c.cx, c.cy - c.R - 16 * k) }
      }
      if (hover) {
        const full = (hover.label || '').replace(/\s+/g, ' ').trim()
        pill([hover.kind, hover.actor_name ? t('graph.byAuthor', { name: hover.actor_name }) : null, full.length > 48 ? full.slice(0, 48).trimEnd() + '…' : full].filter(Boolean).join(' · '), hover.x, hover.y + radius(hover) + 4, true)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const legend = clusterList.slice(0, W < 520 ? 4 : 8)
      const shared = nodes.some((n) => n.workspace === 'company')
      if (legend.length || shared) {
        ctx.font = '600 11px Montserrat, sans-serif'
        const rows = [...legend.map((c) => c.label), ...(shared ? [t('graph.sharedLegend')] : [])]
        const wMax = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 28
        ctx.fillStyle = paper; ctx.fillRect(10, 10, wMax, 8 + rows.length * 17)
        rows.forEach((r, i) => { const y = 10 + 8 + i * 17 + 8; ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(20, y, 4, 0, Math.PI * 2); if (shared && i === rows.length - 1) { ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.stroke() } else ctx.fill(); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = hair; ctx.fillText(r, 30, y) })
      }
    }
    canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); const p = local(ev); zoomAround(p.x, p.y, Math.exp(-ev.deltaY * 0.0015)) }, { passive: false })
    canvas.addEventListener('pointerdown', (ev) => {
      canvas.setPointerCapture(ev.pointerId)
      const p = local(ev)
      pointers.set(ev.pointerId, p)
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; st.pressNode = null; st.panning = false; st.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: cam.scale }; return }
      st.moved = false; st.downId = ev.pointerId; st.pressNode = nodeAt(p.x, p.y); st.panning = true; st.panStart = { x: ev.clientX - cam.x, y: ev.clientY - cam.y }
    })
    canvas.addEventListener('pointermove', (ev) => {
      const p = local(ev)
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p)
      if (st.pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, (dist / st.pinch.dist) * (st.pinch.scale / cam.scale)); return }
      if (st.panning) { cam.x = ev.clientX - st.panStart.x; cam.y = ev.clientY - st.panStart.y; st.moved = true; draw() } else { const prev = st.hover; st.hover = nodeAt(p.x, p.y); if (prev !== st.hover) draw() }
    })
    const end = (ev) => {
      pointers.delete(ev.pointerId)
      try { canvas.releasePointerCapture(ev.pointerId) } catch (e) { /* já solto */ }
      if (st.pinch && pointers.size < 2) st.pinch = null
      if (ev.pointerId === st.downId) { if (st.pressNode && !st.moved) onOpen(st.pressNode); st.pressNode = null; st.panning = false; st.downId = null; draw() }
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('pointerleave', () => { if (!st.panning && st.hover) { st.hover = null; draw() } })
    fit()
    return { zoomBy: (f) => zoomAround(W / 2, H / 2, f), fit }
  }

  function render(host) {
    const canvas = h('canvas', { class: 'graph__canvas', role: 'img', 'aria-label': t('graph.label') })
    const empty = h('div', { class: 'graph__empty', hidden: true }, Parts.EmptyState({ title: t('graph.emptyTitle'), body: t('graph.empty') }))
    let api = null
    const controls = h('div', { class: 'graph__controls', role: 'group', 'aria-label': t('graph.controls') },
      Button({ variant: 'secondary', size: 'sm', 'aria-label': t('graph.zoomOut'), onClick: () => api && api.zoomBy(0.8) }, '−'),
      Button({ variant: 'secondary', size: 'sm', 'aria-label': t('graph.zoomIn'), onClick: () => api && api.zoomBy(1.25) }, '+'),
      Button({ variant: 'secondary', size: 'sm', onClick: () => api && api.fit() }, t('graph.fit')),
      Button({ variant: 'secondary', size: 'sm', onClick: () => load() }, t('graph.relayout')))
    const layerSel = App.team ? Select({ label: t('mem.layer'), options: [{ value: '', label: t('mem.allLayers') }, { value: 'personal', label: t('mem.personalLayer') }, { value: 'company', label: t('mem.sharedLayer') }], value: layer, onChange: (e) => { layer = e.target.value; load() } }) : null
    mount(host, h('p', { class: 'v-caption' }, t('graph.legend')), layerSel, h('div', { class: 'graph' }, canvas, empty, controls))
    async function load() {
      try {
        const data = await Session.api('/graph' + (layer ? `?workspace=${encodeURIComponent(layer)}` : ''))
        if (!data.nodes || !data.nodes.length) { canvas.hidden = true; empty.hidden = false; return }
        empty.hidden = true; canvas.hidden = false
        api = simulate(canvas, data.nodes, data.edges || [], (n) => openNode(n, load))
      } catch (e) { canvas.hidden = true; empty.hidden = false; mount(empty, Parts.ErrorState({ title: t('graph.loadFailed'), onRetry: load })) }
    }
    load()
  }

  g.GraphTab = { render }
})(typeof globalThis !== 'undefined' ? globalThis : window)
