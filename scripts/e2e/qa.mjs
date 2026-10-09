import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);

const ask = async (p, q, { enter = false } = {}) => {
  await p.eval(`(() => { const f=document.querySelector('.composer__field'); f.focus(); f.value=${JSON.stringify(q)}; f.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  if (enter) await p.key("Enter");
  else await p.eval(`document.querySelector('.composer button[type=submit]').click()`);
  await p.wait(300);
  await p.waitFor(`!document.querySelector('.turn:last-of-type .answer-stream[aria-live]') || document.querySelector('.composer button[type=submit]:not([disabled])')`, 15000);
  await p.wait(500);
};
const lastTurn = (p) => p.eval(`(() => { const t=[...document.querySelectorAll('.turn')].pop(); return t ? t.innerText : null })()`);

await withPage({ token: "dev-owner-token" }, async (p) => {
  await p.login();
  log("== topbar ==");
  log(await p.eval(`document.querySelector('.topbar').innerText.replace(/\\n/g,' | ')`));

  log("== 1. pergunta Dique (cliente ativo=?) ==");
  log("cliente ativo:", await p.eval(`App.activeClient`));
  await p.eval(`App.setClient && App.setClient('demo-dir-dique')`);
  await p.wait(500);
  await ask(p, "Qual é a meta de leads da Dique?");
  log(await lastTurn(p));
  await p.shot(`${OUT}/qa-1.png`);

  log("== 2. enter envia? ==");
  await ask(p, "Quem aprova o orçamento da Dique?", { enter: true });
  log((await lastTurn(p))?.slice(0, 400));

  log("== 3. não encontrei ==");
  await ask(p, "xyzzy qwerty plugh frobnicate");
  log((await lastTurn(p))?.slice(0, 500));

  log("== 4. XSS na pergunta ==");
  await ask(p, `<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script>`);
  log("xss executou?", await p.eval(`!!window.__xss`));

  log("== 5. vazio ==");
  const before = await p.eval(`document.querySelectorAll('.turn').length`);
  await p.eval(`(() => { const f=document.querySelector('.composer__field'); f.value='   '; })()`);
  await p.eval(`document.querySelector('.composer button[type=submit]').click()`);
  await p.wait(400);
  log("turnos antes/depois:", before, await p.eval(`document.querySelectorAll('.turn').length`));

  log("== 6. pergunta enorme (6000 chars) ==");
  await ask(p, "Dique ".repeat(1000));
  log((await lastTurn(p))?.slice(0, 200));

  log("== 7. cliente Aurora não vaza Dique ==");
  await p.eval(`App.setClient && App.setClient('demo-dir-aurora')`);
  await p.wait(500);
  await ask(p, "Qual é a meta de leads?");
  const t7 = await lastTurn(p);
  log(t7?.slice(0, 500));
  log("menciona Dique?", /dique/i.test(t7 || ""));

  log("== problemas ==", p.problems, p.net);
});
