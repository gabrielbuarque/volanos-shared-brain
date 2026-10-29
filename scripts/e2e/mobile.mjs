import { withPage } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
await withPage({ w: 390, h: 844, mobile: true }, async (p) => {
  await p.login();
  await p.eval(`App.setClient('demo-dir-dique')`); await p.wait(300);
  await p.eval(`(()=>{const f=document.querySelector('.composer__field'); f.value='Qual é a meta de leads da Dique?'; document.querySelector('.composer button[type=submit]').click()})()`);
  await p.waitFor(`document.querySelector('.turn__sources')`, 15000); await p.wait(500);
  await p.shot(`${OUT}/m-ask.png`);
  for (const [n, r] of [["m-home", "#/perguntar"], ["m-clientes", "#/clientes"], ["m-contribuir", "#/contribuir"], ["m-admin", "#/admin/pessoas"], ["m-convites", "#/admin/convites"]]) {
    await p.eval(`location.hash='${r}'`); await p.wait(1200); await p.shot(`${OUT}/${n}.png`);
  }
});
