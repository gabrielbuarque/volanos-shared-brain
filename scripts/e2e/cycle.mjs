/** Teste decisivo do PRD: Tito compartilha hoje; Letícia pergunta amanhã e encontra, com a permissão correta. */
import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const MARK = "ZEBRA4821";
const DOC = `# Pausa da campanha de março da Dique\n\nDecisão de hoje: a Dique pausa a campanha ${MARK} de março até o orçamento ser reaprovado. O decisor é o diretor comercial.`;

const click = (p, re) => p.eval(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>new RegExp(${JSON.stringify(re)},'i').test(b.innerText)); if(!b) return false; b.click(); return true})()`);
const setField = (p, sel, v) => p.eval(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); if(!f) return false; f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);

await withPage({}, async (p) => {
  log("== 1. P8 (Tito) contribui ==");
  await p.login("demo-token-p8-time");
  await p.goto("/#/contribuir");
  await p.wait(1000);
  log("campos:", await p.eval(`[...document.querySelectorAll('main textarea,main input,main select')].map(e=>e.tagName+'/'+e.type).join(',')`));
  await setField(p, "main textarea", DOC);
  log("analisar:", await click(p, "analis|sugest|continuar"));
  await p.wait(1500);
  log((await p.text()).split("\n").slice(8, 40).join(" | "));
  await p.shot(`${OUT}/cycle-1.png`);
  log("selects:", await p.eval(`[...document.querySelectorAll('main select')].map(s=>s.options[s.selectedIndex]?.text).join(' || ')`));
  log("enviar:", await click(p, "enviar para revis"));
  await p.wait(1500);
  log("toast:", await p.eval(`document.querySelector('.v-toast')?.innerText`));
  log("minhas:", await p.eval(`document.querySelector('.contribute__mine')?.innerText`));

  log("== 2. P8 já encontra? (deveria depender da aprovação) ==");
  await p.goto("/#/perguntar");
  await p.wait(800);

  log("== 3. owner revisa ==");
  await p.login("dev-owner-token");
  await p.goto("/#/contribuir");
  await p.wait(800);
  await click(p, "revis|fila");
  await p.wait(1200);
  log((await p.text()).split("\n").slice(8, 50).join(" | "));
  await p.shot(`${OUT}/cycle-2.png`);
  log("aprovar:", await click(p, "^aprovar"));
  await p.wait(1500);
  log("toast:", await p.eval(`document.querySelector('.v-toast')?.innerText`));

  log("== 4. P6 (Letícia) pergunta ==");
  await p.login("demo-token-p6-gerencia");
  await p.eval(`App.setClient('demo-dir-dique')`);
  await p.wait(500);
  await setField(p, ".composer__field", "A Dique pausou a campanha de março?");
  await p.eval(`document.querySelector('.composer button[type=submit]').click()`);
  await p.waitFor(`document.querySelector('.turn__sources')`, 15000);
  await p.wait(500);
  const t4 = await p.eval(`[...document.querySelectorAll('.turn')].pop().innerText`);
  log(t4.slice(0, 900));
  log("achou a contribuição do Tito?", t4.includes("Pausa da campanha"), "| fonte lista", /ZEBRA|pausa/i.test(t4));
  await p.shot(`${OUT}/cycle-3.png`);
  log("== problemas ==", p.problems, p.net);
});
