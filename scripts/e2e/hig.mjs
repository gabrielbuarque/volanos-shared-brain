/** Auditoria por critérios do Apple HIG que dá para medir no navegador (alvos, tipografia, contraste, foco, estrutura). */
import { withPage } from "./harness.mjs";
const log = (...a) => console.log(...a);

const AUDIT = `(() => {
  const out = { small: [], tiny: [], inputZoom: [], contrast: [], nofocus: [], heads: [], lowSpacing: [] };
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r,g,b,a=1] = m[1].split(',').map(Number); return {r,g,b,a}; };
  const lum = ({r,g,b}) => { const f = (v) => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4) }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b) };
  const bgOf = (el) => { let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; n = n.parentElement } return {r:255,g:255,b:255,a:1} };
  const label = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '') + '[' + (el.getAttribute('aria-label') || el.innerText || el.placeholder || '').trim().slice(0, 24) + ']';
  const vis = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const mobile = innerWidth < 600;
  for (const el of document.querySelectorAll('button, a[href], select, input:not([type=hidden]):not(.v-sr-only), textarea, [role=tab]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const min = mobile ? 44 : 24;
    if (r.height < min || r.width < min) out.small.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (mobile && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) && parseFloat(getComputedStyle(el).fontSize) < 16) out.inputZoom.push(label(el) + ' ' + getComputedStyle(el).fontSize);
  }
  const seen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (el.children.length && ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!el.childNodes.length || !vis(el)) continue;
    const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    if (fs < 12) out.tiny.push(label(el) + ' ' + fs + 'px');
    const fg = parse(cs.color), bg = bgOf(el);
    if (fg && el.closest('#login') == null) {
      const a = lum(fg) + 0.05, b = lum(bg) + 0.05; const ratio = Math.max(a,b)/Math.min(a,b);
      const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) { const k = label(el)+ratio.toFixed(1); if(!seen.has(k)){seen.add(k); out.contrast.push(label(el) + ' ' + ratio.toFixed(2) + ':1 @' + fs + 'px')} }
    }
  }
  const focusables = [...document.querySelectorAll('button, a[href], select, input:not(.v-sr-only), textarea, [role=tab]')].filter(vis).slice(0, 25);
  for (const el of focusables) { el.focus(); const cs = getComputedStyle(el); const ok = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none'; if (!ok) out.nofocus.push(label(el)); }
  out.heads = [...document.querySelectorAll('h1,h2,h3,h4')].filter(vis).map(h => h.tagName + ':' + h.innerText.trim().slice(0, 30));
  out.landmarks = ['header','nav','main','footer'].map(t => t + '=' + document.querySelectorAll(t + ',[role=' + ({header:'banner',nav:'navigation',main:'main',footer:'contentinfo'})[t] + ']').length).join(' ');
  out.title = document.title; out.lang = document.documentElement.lang;
  out.viewport = document.querySelector('meta[name=viewport]')?.content;
  out.hscroll = document.documentElement.scrollWidth > innerWidth + 1;
  return out;
})()`;

const ROUTES = ["#/memorias/recentes", "#/memorias/grafo", "#/memorias/resumo", "#/memorias/atividade", "#/memorias/equipe", "#/perguntar", "#/clientes", "#/clientes/demo-dir-dique", "#/contribuir", "#/admin/pessoas", "#/admin/convites", "#/admin/integracoes", "#/admin/auditoria", "#/admin/avancado"];
for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
  await withPage({ w, h, mobile }, async (p) => {
    await p.login();
    log(`\n######## ${w}px ########`);
    for (const r of ROUTES) {
      await p.goto("/" + r);
      await p.eval(`location.hash='${r}'`);
      await p.wait(1300);
      const a = await p.eval(AUDIT);
      log(`\n--- ${r} | título="${a.title}" lang=${a.lang} | landmarks ${a.landmarks} | hscroll=${a.hscroll}`);
      log("viewport:", a.viewport);
      log("headings:", a.heads.join(", "));
      for (const k of ["small", "inputZoom", "tiny", "contrast", "nofocus"]) if (a[k].length) log(`  ${k} (${a[k].length}):`, [...new Set(a[k])].slice(0, 8).join(" ; "));
    }
    log("problemas:", p.problems);
  });
}
