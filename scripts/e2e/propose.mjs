import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const NL = "String.fromCharCode(10)";
const flat = (expr) => `((${expr})||'').split(${NL}).join(' | ')`;
const click = (p, re) => p.eval(`(()=>{const b=[...document.querySelectorAll('button,a,summary')].find(b=>new RegExp(${JSON.stringify(re)},'i').test(b.innerText||b.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true})()`);
const setField = (p, sel, v) => p.eval(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); if(!f) return false; f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);

await withPage({}, async (p) => {
  log("== P8 propõe edição na Planilha da Dique ==");
  await p.login("demo-token-p8-time");
  await p.eval(`location.hash='#/doc/demo-dique-p12-planilha'`); await p.wait(1200);
  log("botões:", await p.eval(`[...document.querySelectorAll('.page-head__actions button')].map(b=>b.innerText).join(' | ')`));
  log("propor:", await click(p, "^propor edição"));
  await p.wait(500);
  const cur = await p.eval(`document.querySelector('.v-dialog textarea').value`);
  await setField(p, ".v-dialog textarea", cur.split(String.fromCharCode(10)).join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10) + "## Revisão" + String.fromCharCode(10) + "- Meta revista para 950 leads.");
  await p.shot(`${OUT}/pr-dialog.png`);
  log("enviar:", await p.eval(`(()=>{const b=[...document.querySelectorAll('.v-dialog .v-dialog__actions button')].pop(); b.click(); return b.innerText})()`));
  await p.wait(1200);
  log("toast:", await p.eval(flat(`document.querySelector('.v-toast')?.innerText`)));

  log("== Owner revisa com diff ==");
  await p.login("dev-owner-token");
  await p.eval(`location.hash='#/contribuir'`); await p.wait(900);
  await click(p, "fila de revisão"); await p.wait(1200);
  log(await p.eval(flat(`document.querySelector('.reviewlist')?.innerText`)));
  await p.shot(`${OUT}/pr-review.png`);
  log("aprovar:", await click(p, "^aprovar")); await p.wait(1500);
  log("toast:", await p.eval(flat(`document.querySelector('.v-toast')?.innerText`)));

  log("== Documento depois: estrutura e histórico ==");
  await p.eval(`location.hash='#/doc/demo-dique-p12-planilha'`); await p.wait(1500);
  log("h2 no doc:", await p.eval(`[...document.querySelectorAll('.doc__body h2')].map(h=>h.innerText).join(',')`), "| li:", await p.eval(`document.querySelectorAll('.doc__body li').length`));
  log(await p.eval(flat(`document.querySelector('.doc__history').innerText`)));
  await p.eval(`document.querySelector('.history__item summary')?.click()`); await p.wait(300);
  await p.shot(`${OUT}/pr-history.png`);
  log("problemas:", p.problems, p.net.slice(-4));
});
