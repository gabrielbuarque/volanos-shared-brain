import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);

await withPage({ token: "dev-owner-token" }, async (p) => {
  await p.login();
  await p.goto("/#/admin/pessoas");
  await p.wait(1200);
  log("== rota admin ==", await p.eval(`location.hash`));
  log("abas:", await p.eval(`[...document.querySelectorAll('[role=tab]')].map(t=>t.innerText).join(' | ')`));

  await p.shot(`${OUT}/acc-1.png`);

  log("== botões e campos ==");
  log(await p.eval(`[...document.querySelectorAll('main button, main input, main select')].map(e=>e.tagName+':'+(e.getAttribute('aria-label')||e.innerText||e.placeholder||e.name||'').trim().slice(0,40)).join('\\n')`));

  await p.goto("/#/admin/convites"); await p.wait(1000); await p.shot(OUT+"/acc-conv.png");
log("== convite: e-mail inválido ==");
  const setForm = (email) => p.eval(`(() => { const i=[...document.querySelectorAll('main input')].find(x=>/mail/i.test(x.type+x.name+x.placeholder+(x.getAttribute('aria-label')||''))); if(!i) return 'sem campo de e-mail'; i.value=${JSON.stringify(email)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'})()`);
  log(await setForm("isso-nao-e-email"));
  await p.eval(`[...document.querySelectorAll('main button')].find(b=>/convid|enviar|criar/i.test(b.innerText))?.click()`);
  await p.wait(800);
  log((await p.text()).match(/(inv[aá]lid|erro|use o e-mail)[^\n]*/i)?.[0] || "nenhuma mensagem de erro visível");

  log("== convite válido ==");
  log(await setForm("nova.pessoa@volanos.ca"));
  await p.eval(`[...document.querySelectorAll('main button')].find(b=>/convid|enviar|criar/i.test(b.innerText))?.click()`);
  await p.wait(1200);
  const t = await p.text();
  log(t.slice(t.indexOf("CONVIT"), t.indexOf("CONVIT") + 700));
  await p.shot(`${OUT}/acc-2.png`);

  log("== duplicado ==");
  log(await setForm("nova.pessoa@volanos.ca"));
  await p.eval(`[...document.querySelectorAll('main button')].find(b=>/convid|enviar|criar/i.test(b.innerText))?.click()`);
  await p.wait(800);
  log((await p.text()).match(/(já|duplic|existe)[^\n]*/i)?.[0] || "sem aviso de duplicado");

  log("== domínio fora da Volanos ==");
  log(await setForm("alguem@gmail.com"));
  await p.eval(`[...document.querySelectorAll('main button')].find(b=>/convid|enviar|criar/i.test(b.innerText))?.click()`);
  await p.wait(800);
  log((await p.text()).match(/(domínio|não permit|volanos)[^\n]*/i)?.[0] || "aceitou/sem aviso");

  log("== API: convites e membros ==");
  log(JSON.stringify(await p.api("/team/invites")).slice(0, 600));
  log(JSON.stringify(await p.api("/team/members")).slice(0, 900));

  log("== como P8 (não admin) ==");
  await p.login("demo-token-p8-time");
  await p.goto("/#/admin/pessoas");
  await p.wait(900);
  log("hash:", await p.eval(`location.hash`), "| topbar:", await p.eval(`document.querySelector('.topbar').innerText.replace(/\\n/g,' | ')`));
  log((await p.api("/team/invites", {}, "demo-token-p8-time")).status, (await p.api("/team/members", {}, "demo-token-p8-time")).status);

  log("== problemas ==", p.problems, p.net);
});
