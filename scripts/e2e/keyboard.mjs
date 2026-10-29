import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const D = "(()=>{const a=document.activeElement; if(!a||a===document.body) return 'body'; const cs=getComputedStyle(a); const r=a.getBoundingClientRect(); return a.tagName.toLowerCase()+'['+((a.getAttribute('aria-label')||a.innerText||a.placeholder||'').trim().slice(0,22))+'] outline='+cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor+' shadow='+(cs.boxShadow==='none'?'no':'sim')+' visivel='+(r.width>0&&r.top>=0&&r.bottom<=innerHeight)})()";
await withPage({}, async (p) => {
  await p.login();
  await p.eval(`location.hash='#/perguntar'`); await p.wait(800);
  await p.eval(`document.body.focus(); document.activeElement.blur()`);
  log("== Tab pela tela Perguntar ==");
  for (let i = 0; i < 14; i++) { await p.key("Tab"); await p.wait(60); log(i + 1, await p.eval(D)); }
  await p.shot(`${OUT}/kb-1.png`);
  log("== diálogo: foco preso? ==");
  await p.eval(`document.querySelector('.topbar__profile').click()`); await p.wait(500);
  log("foco ao abrir:", await p.eval(D));
  const seen = new Set();
  for (let i = 0; i < 8; i++) { await p.key("Tab"); await p.wait(60); seen.add(await p.eval(`(document.activeElement.innerText||document.activeElement.tagName).slice(0,20)+'|inDialog='+!!document.activeElement.closest('dialog,.v-dialog')`)); }
  log([...seen].join("  //  "));
  await p.key("Escape"); await p.wait(400);
  log("depois do Esc, foco em:", await p.eval(D));
  log("== skip link / main focus ==");
  log(await p.eval(`!!document.querySelector('a[href="#view"],.skip-link,.v-skip')`));
});
