import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const section = (s) => log(`\n=========== ${s} ===========`);
const NL = "String.fromCharCode(10)";
const flat = (expr) => `((${expr})||'').split(${NL}).join(' | ')`;
const click = (p, re) => p.eval(`(()=>{const b=[...document.querySelectorAll('button,a,summary')].find(b=>new RegExp(${JSON.stringify(re)},'i').test(b.innerText||b.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true})()`);
const setField = (p, sel, v) => p.eval(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const submit = async (p, q) => { await setField(p, ".composer__field", q); await p.eval(`document.querySelector('.composer button[type=submit]').click()`); };
const SLOW = `(()=>{ if(window.__orig) return; window.__orig=window.fetch; window.fetch=(u,o)=>{ const s=String(u); const d = /\\/chat/.test(s)?2500:/\\/recall/.test(s)?800:0; return new Promise(r=>setTimeout(()=>r(window.__orig(u,o)),d)) } })()`;

await withPage({}, async (p) => {
  await p.login();
  await p.eval(`App.setClient('demo-dir-dique')`); await p.wait(300);
  await p.eval(SLOW);

  section("1. carregando: esqueleto e Parar");
  await submit(p, "Qual é a meta de leads da Dique?");
  await p.wait(400);
  log("esqueleto visível:", await p.eval(`!!document.querySelector('.skeleton')`), "| botão parar:", await p.eval(`!![...document.querySelectorAll('.turn button')].find(b=>/parar/i.test(b.innerText))`));
  await p.shot(`${OUT}/st-loading.png`);
  await p.wait(1200);
  log("parar (durante /chat):", await click(p, "^parar"));
  await p.wait(600);
  log("estado após parar:", (await p.eval(flat(`document.querySelector('.turn:last-of-type')?.innerText`))).slice(0, 260));
  log("campo livre para nova pergunta:", await p.eval(`!document.querySelector('.composer button[type=submit]').disabled`));

  section("2. trocar de cliente no meio da resposta");
  await submit(p, "Resumo da Dique");
  await p.wait(500);
  await p.eval(`(()=>{const s=document.querySelector('.topbar__client select'); s.value='demo-dir-aurora'; s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await p.wait(4500);
  log("turnos após troca:", await p.eval(`document.querySelectorAll('.turn').length`), "(esperado 0) | busy preso:", await p.eval(`!!document.querySelector('.composer button[type=submit]').disabled`));
  await submit(p, "Meta da Aurora");
  await p.wait(5000);
  const t = await p.eval(flat(`document.querySelector('.turn:last-of-type')?.innerText`));
  log("nova pergunta funciona:", t.slice(0, 200), "| cita Dique?", /dique/i.test(t));

  section("3. sessão expira no meio do uso (401)");
  await p.eval(`window.fetch=(u,o)=>Promise.resolve(new Response(JSON.stringify({ok:false,error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}))`);
  await submit(p, "pergunta com sessão expirada");
  await p.wait(1500);
  log("tela:", (await p.text()).replace(/\n+/g, " | ").slice(0, 260));
  await p.shot(`${OUT}/st-401.png`);

  section("4. navegação: voltar e avançar");
  await p.login();
  for (const h of ["#/clientes", "#/contribuir", "#/perguntar"]) { await p.eval(`location.hash='${h}'`); await p.wait(400); }
  await p.eval(`history.back()`); await p.wait(600);
  log("após voltar:", await p.eval(`location.hash`), "| link ativo:", await p.eval(`document.querySelector('.topbar__link[aria-current=page]')?.innerText`));
  await p.eval(`history.forward()`); await p.wait(600);
  log("após avançar:", await p.eval(`location.hash`), "| link ativo:", await p.eval(`document.querySelector('.topbar__link[aria-current=page]')?.innerText`));

  section("5. entradas estranhas");
  for (const q of ["🙂🙂🙂 meta?", "مرحبا meta de leads", "' OR 1=1 --", "<script>window.__x=1</script>", "a".repeat(30000)]) {
    await p.eval(`App.setClient('demo-dir-dique')`); await p.wait(200);
    await submit(p, q); await p.wait(1000);
    await p.waitFor(`!document.querySelector('.composer button[type=submit]').disabled`, 9000);
    log(JSON.stringify(q.slice(0, 20)), "→", (await p.eval(flat(`document.querySelector('.turn:last-of-type .turn__a')?.innerText`))).slice(0, 90), "| x:", await p.eval(`!!window.__x`));
  }
  log("problemas:", p.problems.slice(0, 5), p.net.slice(-4));
});
