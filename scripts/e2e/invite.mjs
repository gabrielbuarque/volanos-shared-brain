import { withPage, BASE } from "./harness.mjs";
const OUT = process.env.SHOTS || (process.env.TEMP || "/tmp") + "/sbshots";
const log = (...a) => console.log(...a);

await withPage({ token: "dev-owner-token" }, async (p) => {
  await p.login();
  log("== API convite inválido ==");
  log(JSON.stringify(await p.api("/team/invites", { method: "POST", body: JSON.stringify({ email: "isso-nao-e-email", role: "member", clearance_floor: 7 }) })));
  log("== API nível inválido ==");
  log(JSON.stringify(await p.api("/team/invites", { method: "POST", body: JSON.stringify({ email: "x@volanos.ca", role: "member", clearance_floor: 99 }) })));
  log("== API papel inválido ==");
  log(JSON.stringify(await p.api("/team/invites", { method: "POST", body: JSON.stringify({ email: "y@volanos.ca", role: "owner", clearance_floor: 7 }) })));
  log("== convite P9 freela ==");
  const r = await p.api("/team/invites", { method: "POST", body: JSON.stringify({ email: "freela@externo.com", role: "member", clearance_floor: 9 }) });
  log(r.status, r.body.slice(0, 400));
  const link = JSON.parse(r.body).link || JSON.parse(r.body).url || "";
  log("link:", link);

  log("== UI: convite no navegador deslogado ==");
  const tok = (link.match(/invite=([^&]+)/) || [])[1];
  await p.eval(`localStorage.clear()`);
  await p.goto("/?a=1#invite=" + (tok || "x"));
  await p.wait(1500);
  log(await p.text());
  await p.shot(`${OUT}/invite-ok.png`);

  log("== UI: convite inválido ==");
  await p.goto("/?b=2#invite=tokeninvalido123");
  await p.wait(1500);
  log(await p.text());
  await p.shot(`${OUT}/invite-bad.png`);

  log("== sessão: dev sem Google ==");
  log(JSON.stringify(await p.api("/auth/google/start", { method: "POST", body: JSON.stringify({ invite: tok }) })).slice(0, 200));
  log("== problemas ==", p.problems);
});
