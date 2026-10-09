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
  { name: "todos-os-clientes", run: async (p) => { await pickClient(p, "all"); await ready(p, ".ask__hero"); await askText(p, "Qual é a meta de leads?"); await p.wait(400); } },
  { name: "meu-espaco", path: "/#/contribuir", run: async (p) => { await ready(p, ".dropzone"); await p.eval(`fetch('/capture', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('sb_token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '# Ideia para a renovação' + String.fromCharCode(10) + 'Oferecer 20% de desconto se a Dique renovar por 12 meses.', workspace: 'personal', source: 'note' }) })`); await p.wait(500); await p.eval(`[...document.querySelectorAll('[role=tab]')].find((t) => /espaço/i.test(t.textContent)).click()`); await ready(p, ".reviewcard"); await p.wait(900); } },
  { name: "historico", path: "/#/doc/demo-dique-p12-planilha", run: async (p) => { await ready(p, ".doc__body"); await p.eval(`fetch('/entry/propose-edit', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('sb_token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo-dique-p12-planilha', content: '# Planilha de metas do trimestre' + String.fromCharCode(10) + 'A meta de leads qualificados da Dique é de 900 leads por mês.' + String.fromCharCode(10) + String.fromCharCode(10) + '## Revisão' + String.fromCharCode(10) + '- Meta revista em reunião, sem mudança de valor.' }) })`); await p.wait(800); await p.goto("/?r=1#/doc/demo-dique-p12-planilha"); await ready(p, ".history__item"); await p.eval(`document.querySelector('.history__item summary').click()`); await p.eval(`document.querySelector('.doc__history').scrollIntoView({block:'center'})`); await p.wait(400); } },
  { name: "pessoas-mais", path: "/#/admin", run: async (p) => { await ready(p, ".matrix__row"); await p.eval(`document.querySelectorAll('.matrix__more summary')[2].click()`); await p.wait(300); } },
  { name: "admin-avancado", path: "/#/admin/avancado", full: true, run: async (p) => { await p.wait(2000); } },
];
