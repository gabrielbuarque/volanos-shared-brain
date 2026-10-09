/** Cenas do conjunto "depois" (interface redesenhada). Usadas por scripts/capture-screens.mjs. */
const ready = (p, sel, ms = 8000) => p.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, ms);
const pickClient = async (p, id) => {
  await ready(p, ".topbar__client select");
  await p.eval(`(() => { const s = document.querySelector('.topbar__client select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.wait(500);
};
const askText = async (p, text) => {
  await ready(p, ".composer__field");
  await p.eval(`(() => { const f = document.querySelector('.composer__field'); f.value = ${JSON.stringify(text)}; f.form.requestSubmit(); })()`);
  await ready(p, ".turn__scope, .state", 12000);
  await p.wait(500);
};
export default [
  { name: "styleguide", path: "/styleguide", full: true, run: async (p) => { await ready(p, ".sg-section"); await p.wait(500); } },
  { name: "home", run: async (p) => { await pickClient(p, "demo-dir-dique"); await ready(p, ".ask__hero"); await p.wait(400); } },
  { name: "chat", run: async (p) => { await pickClient(p, "demo-dir-dique"); await ready(p, ".ask__hero"); await p.eval(`document.querySelector('.ask__shortcuts button')?.click()`); await ready(p, ".turn__scope", 12000); await p.wait(500); } },
  { name: "conflito", run: async (p) => { await pickClient(p, "demo-dir-dique"); await askText(p, "Qual é a meta de leads qualificados da Dique?"); await p.eval(`document.querySelector('.conflict')?.scrollIntoView({block:'center'})`); await p.wait(300); } },
  { name: "nao-encontrei", run: async (p) => { await pickClient(p, "demo-dir-dique"); await askText(p, "Qual é a meta de leads?"); } },
  { name: "clientes", path: "/#/clientes", run: async (p) => { await ready(p, ".clientlist"); await p.wait(400); } },
  { name: "cliente", path: "/#/clientes/demo-dir-dique", run: async (p) => { await ready(p, ".canonitem"); await p.wait(400); } },
  { name: "documento", path: "/#/doc/demo-dique-p12-resumo", run: async (p) => { await ready(p, ".doc__body"); await p.wait(400); } },
  { name: "contribuir", path: "/#/contribuir", run: async (p) => { await ready(p, ".dropzone"); await p.wait(400); } },
  { name: "admin", path: "/#/admin", run: async (p) => { await ready(p, ".matrix__row"); await p.wait(400); } },
  { name: "ver-como", path: "/#/admin", run: async (p) => { await ready(p, ".matrix__row"); await p.eval(`[...document.querySelectorAll('.matrix__row')].find((r) => r.textContent.includes('Demo Time')).querySelector('.v-btn--ghost').click()`); await ready(p, ".viewas", 8000); await p.wait(800); await pickClient(p, "demo-dir-dique"); await ready(p, ".ask__hero"); await p.wait(400); } },
  { name: "admin-avancado", path: "/#/admin/avancado", full: true, run: async (p) => { await p.wait(2000); } },
];
