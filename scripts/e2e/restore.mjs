/** Funcionalidades da interface anterior que voltaram: memórias, grafo, resumo, atividade, equipe, guardar, dados. */
import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);
const section = (s) => log(`\n=========== ${s} ===========`);
const NL = "String.fromCharCode(10)";
const flat = (expr) => `((${expr})||'').split(${NL}).join(' | ')`;
const click = (p, re, scope = "document") => p.eval(`(()=>{const b=[...${scope}.querySelectorAll('button,a,summary')].find(b=>new RegExp(${JSON.stringify(re)},'i').test(b.innerText||b.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true})()`);
const setField = (p, sel, v) => p.eval(`(()=>{const f=document.querySelector(${JSON.stringify(sel)}); if(!f) return false; f.value=${JSON.stringify(v)}; f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
const toast = (p) => p.eval(flat(`document.querySelector('.v-toast')?.innerText`));

await withPage({}, async (p) => {
  await p.login();

  section("1. Perguntar: guardar uma anotação (modo lembrar) com #tags");
  await p.eval(`location.hash='#/perguntar'`); await p.wait(800);
  await setField(p, ".composer__field", "Decidi priorizar o funil da Dique #funil #dique");
  await p.wait(200);
  log("modo detectado:", await p.eval(`document.querySelector('.composer__tools button')?.innerText`), "| botão:", await p.eval(`document.querySelector('.composer button[type=submit]').innerText`));
  await p.eval(`document.querySelector('.composer button[type=submit]').click()`); await p.wait(1500);
  log("recibo:", await p.eval(flat(`document.querySelector('.turn__note[role=status]')?.innerText`)));
  await setField(p, ".composer__field", "Quem decide o orçamento da Dique?"); await p.wait(200);
  log("pergunta → modo:", await p.eval(`document.querySelector('.composer__tools button')?.innerText`));
  log("sugestões:", await p.eval(`document.querySelectorAll('.ask__shortcuts')[1]?.children.length`), "| filtros:", await p.eval(`!!document.querySelector('.ask__filters')`));
  await p.shot(`${OUT}/rs-ask.png`);

  section("2. Memórias: lista, filtros, abrir, anexar, editar, esquecer");
  await p.eval(`location.hash='#/memorias'`); await p.wait(1500);
  log("abas:", await p.eval(`[...document.querySelectorAll('[role=tab]')].map(t=>t.innerText).join(' | ')`));
  log("cartões:", await p.eval(`document.querySelectorAll('.memcard').length`), "| grupos:", await p.eval(`[...document.querySelectorAll('.mem-group .v-eyebrow')].map(e=>e.innerText).join(', ')`));
  log("filtros:", await p.eval(`[...document.querySelectorAll('.mem-filters label')].map(l=>l.innerText).join(' | ')`));
  await p.shot(`${OUT}/rs-mem.png`);
  await p.eval(`(()=>{const s=[...document.querySelectorAll('.mem-filters select')][0]; s.value=[...s.options].find(o=>o.value)?.value||''; s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await p.wait(400);
  log("após filtro de tag:", await p.eval(`document.querySelectorAll('.memcard').length`));
  await p.eval(`(()=>{const s=[...document.querySelectorAll('.mem-filters select')][0]; s.value=''; s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await p.wait(300);
  await p.eval(`document.querySelector('.memcard__open').click()`); await p.wait(1200);
  log("leitura:", await p.eval(flat(`document.querySelector('.v-dialog')?.innerText`)));
  await p.shot(`${OUT}/rs-view.png`);
  await p.key("Escape"); await p.wait(300);
  log("anexar:", await click(p, "^anexar", "document.querySelector('.memcard')")); await p.wait(500);
  await setField(p, ".v-dialog textarea", "Atualização: o orçamento foi aprovado.");
  log("salvar:", await p.eval(`(()=>{const b=[...document.querySelectorAll('.v-dialog .v-dialog__actions button')].pop(); b.click(); return b.innerText})()`)); await p.wait(1200);
  log("toast:", await toast(p));
  log("compartilhar via Mais:", await click(p, "^mais", "document.querySelector('.memcard')"));

  section("3. Esquecer (confirmação)"); await p.wait(1500);
  const before = await p.eval(`document.querySelectorAll('.memcard').length`);
  await p.eval(`document.querySelector('.memcard .mem-more summary').click()`); await p.wait(200);
  await p.eval(`[...document.querySelectorAll('.memcard .mem-more button')].find(b=>/esquecer/i.test(b.textContent)).click()`); await p.wait(500);
  log("diálogo:", await p.eval(flat(`document.querySelector('.v-dialog')?.innerText`)));
  await p.eval(`[...document.querySelectorAll('.v-dialog .v-dialog__actions button')].pop().click()`); await p.wait(1500);
  log("cartões antes/depois:", before, await p.eval(`document.querySelectorAll('.memcard').length`), "| toast:", await toast(p));

  section("4. Grafo");
  await p.eval(`location.hash='#/memorias/grafo'`); await p.wait(1800);
  log("canvas visível:", await p.eval(`(()=>{const c=document.querySelector('.graph__canvas'); return !!c && !c.hidden && c.width>0})()`), "| vazio:", await p.eval(`!document.querySelector('.graph__empty').hidden`));
  log("controles:", await p.eval(`[...document.querySelectorAll('.graph__controls button')].map(b=>b.innerText||b.getAttribute('aria-label')).join(' | ')`));
  await p.shot(`${OUT}/rs-graph.png`);

  section("5. Resumo: painéis, padrões e desatualizados");
  await p.eval(`location.hash='#/memorias/resumo'`); await p.wait(2000);
  log((await p.eval(flat(`document.querySelector('.mem-body').innerText`))).slice(0, 900));
  await p.shot(`${OUT}/rs-brief.png`);

  section("6. Atividade (admin) e Equipe");
  await p.eval(`location.hash='#/memorias/atividade'`); await p.wait(1500);
  log((await p.eval(flat(`document.querySelector('.mem-body').innerText`))).slice(0, 500));
  await p.eval(`location.hash='#/memorias/equipe'`); await p.wait(1800);
  log((await p.eval(flat(`document.querySelector('.mem-body').innerText`))).slice(0, 1100));
  await p.shot(`${OUT}/rs-team.png`);

  section("7. Perfil: nome, MCP, dados");
  await p.eval(`document.querySelector('.topbar__profile').click()`); await p.wait(500);
  log((await p.eval(flat(`document.querySelector('.v-dialog')?.innerText`))).slice(0, 700));
  await p.shot(`${OUT}/rs-profile.png`);
  await p.key("Escape");

  section("8. Admin > Avançado: manutenção");
  await p.eval(`location.hash='#/admin/avancado'`); await p.wait(2500);
  log((await p.eval(flat(`document.querySelector('.upkeep, .admin__section')?.closest('main').innerText`))).includes("Manutenção"));

  section("9. Membro (P8): equipe somente leitura, sem Atividade");
  await p.login("demo-token-p8-time");
  await p.eval(`location.hash='#/memorias'`); await p.wait(1500);
  log("abas P8:", await p.eval(`[...document.querySelectorAll('[role=tab]')].map(t=>t.innerText).join(' | ')`));
  await p.eval(`location.hash='#/memorias/equipe'`); await p.wait(1500);
  log((await p.eval(flat(`document.querySelector('.mem-body').innerText`))).slice(0, 600));
  log("API admin/atividade como P8:", (await p.api("/team/activity", {}, "demo-token-p8-time")).status);
  log("problemas:", p.problems.slice(0, 6), p.net.slice(-6));
});
