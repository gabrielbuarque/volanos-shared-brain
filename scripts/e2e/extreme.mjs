import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const click = (p, re, scope = "document") => p.eval(`(()=>{const b=[...${scope}.querySelectorAll('button,a,summary')].find(b=>new RegExp(${JSON.stringify(re)},'i').test(b.innerText||b.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true})()`);
const setField = (p, sel, v) => p.eval(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); if(!f) return false; f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
const ask = async (p, q) => { await setField(p, ".composer__field", q); await p.eval(`document.querySelector('.composer button[type=submit]').click()`); await p.wait(400); await p.waitFor(`document.querySelector('.turn:last-of-type .turn__sources, .turn:last-of-type .state')`, 15000); await p.wait(400); };
const section = (s) => log(`\n=========== ${s} ===========`);

await withPage({}, async (p) => {
  section("A. troca de cliente pelo select de verdade");
  await p.login();
  await p.eval(`(()=>{const s=document.querySelector('.topbar__client select, select.topbar__client, .topbar__client'); const sel = s.tagName==='SELECT'?s:s.querySelector('select'); sel.value='demo-dir-dique'; sel.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await p.wait(600);
  log("eyebrow:", await p.eval(`document.querySelector('.v-eyebrow')?.innerText`), "| ativo:", await p.eval(`App.activeClient`));
  await ask(p, "Resumo do cliente");
  log("turnos:", await p.eval(`document.querySelectorAll('.turn').length`));
  await p.eval(`(()=>{const sel=document.querySelector('.topbar__client select')||document.querySelector('select.topbar__client'); sel.value='demo-dir-aurora'; sel.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await p.wait(600);
  log("após trocar: turnos =", await p.eval(`document.querySelectorAll('.turn').length`), "(esperado 0)");
  await p.goto("/"); await p.wait(1200);
  log("persistiu após recarregar:", await p.eval(`App.activeClient`));

  section("B. chip [n] abre e destaca fonte");
  await p.eval(`App.setClient('demo-dir-dique')`); await p.wait(300);
  await ask(p, "Qual é a meta de leads da Dique?");
  await p.eval(`document.querySelector('.turn .cite')?.click()`); await p.wait(500);
  log("chip → foco/aberto:", await p.eval(`(()=>{const a=document.activeElement; return a && a.className + ' open=' + (a.querySelector && a.querySelector('details')?.open)})()`));

  section("C. ações do fim da resposta");
  log("rascunho de proposta:", await click(p, "rascunho de proposta")); await p.wait(1200);
  log("→", (await p.eval(`document.querySelector('.turn:last-of-type')?.innerText.slice(-300)`)).replace(/\n/g, " | "));
  log("abrir no claude:", await click(p, "abrir no claude")); await p.wait(600);
  log("dialog:", (await p.eval(`document.querySelector('dialog,.v-dialog')?.innerText`) || "SEM DIALOG").replace(/\n/g, " | ").slice(0, 700));
  await p.shot(`${OUT}/ex-claude.png`);
  await p.key("Escape"); await p.wait(400);
  log("Esc fechou:", await p.eval(`!document.querySelector('dialog[open],.v-dialog')`), "| foco voltou a:", await p.eval(`document.activeElement?.innerText?.slice(0,30)`));
  log("salvar no canon:", await click(p, "salvar no canon")); await p.wait(600);
  log("dialog:", (await p.eval(`document.querySelector('dialog,.v-dialog')?.innerText`) || "SEM DIALOG").replace(/\n/g, " | ").slice(0, 500));
  await p.shot(`${OUT}/ex-canon.png`);
  await p.key("Escape"); await p.wait(300);
  log("sinalizar conflito:", await click(p, "sinalizar")); await p.wait(1000);
  log("toast:", await p.eval(`document.querySelector('.v-toast')?.innerText`));

  section("D. erro de rede");
  await p.eval(`window.__f=window.fetch; window.fetch=()=>Promise.reject(new TypeError('Failed to fetch'))`);
  await ask(p, "pergunta durante queda de rede");
  log((await p.eval(`document.querySelector('.turn:last-of-type')?.innerText`)).replace(/\n/g, " | ").slice(0, 300));
  await p.shot(`${OUT}/ex-erro.png`);
  await p.eval(`window.fetch=window.__f`);
  log("botão 'tentar de novo' existe:", await click(p, "tentar de novo|repetir"));

  section("E. envio duplo rápido");
  await p.eval(`(async()=>{const f=document.querySelector('.composer__field'); f.value='Qual é a meta de leads da Dique?'; const b=document.querySelector('.composer button[type=submit]'); b.click(); b.click(); b.click();})()`);
  await p.wait(3000);
  log("turnos após 3 cliques:", await p.eval(`document.querySelectorAll('.turn').length`));

  section("F. Clientes e documento");
  await p.goto("/#/clientes"); await p.eval(`location.hash='#/clientes'`); await p.wait(1200);
  log((await p.text()).split("\n").slice(9, 40).join(" | "));
  await p.eval(`document.querySelector('a.clientrow')?.click()`); await p.wait(1200);
  log("detalhe:", (await p.text()).split("\n").slice(9, 40).join(" | "));
  await p.shot(`${OUT}/ex-cliente.png`);
  await click(p, "^fontes"); await p.wait(800);
  log("fontes:", (await p.text()).split("\n").slice(14, 50).join(" | "));
  await p.eval(`document.querySelector('.source__open, a[href^="#/doc/"]')?.click()`); await p.wait(1200);
  log("doc:", (await p.text()).split("\n").slice(9, 40).join(" | "));
  await p.shot(`${OUT}/ex-doc.png`);
  log("rota desconhecida:"); await p.eval(`location.hash='#/lixo/xyz'`); await p.wait(600); log(await p.eval(`location.hash`));
  log("doc inexistente:"); await p.eval(`location.hash='#/doc/nao-existe'`); await p.wait(900); log((await p.text()).split("\n").slice(9, 20).join(" | "));

  section("G. i18n EN");
  await p.eval(`setLocale('en')`); await p.wait(500); await p.eval(`location.hash='#/perguntar'`); await p.wait(800);
  const en = await p.text();
  log(en.split("\n").slice(0, 25).join(" | "));
  log("chaves cruas vazando:", [...new Set(en.match(/\b[a-z]+\.[a-zA-Z.]{3,}\b/g) || [])].slice(0, 10));
  await p.eval(`setLocale('pt')`);

  section("H. sessão: token inválido e sair");
  await p.eval(`localStorage.setItem('sb_token','token-errado')`); await p.goto("/"); await p.wait(1200);
  log((await p.text()).slice(0, 400).replace(/\n/g, " | "));
  log("problemas:", p.problems, p.net);
});
