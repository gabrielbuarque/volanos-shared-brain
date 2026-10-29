#!/usr/bin/env node
/**
 * Captura as telas do Shared Brain em 1280px e 390px, falando com o Edge pelo
 * Chrome DevTools Protocol (sem dependências: WebSocket nativo do Node).
 *
 *   node scripts/capture-screens.mjs --set antes  --out docs/volanos/redesign/antes
 *   node scripts/capture-screens.mjs --set depois --out docs/volanos/redesign/depois
 *
 * Pré-requisito: `node scripts/dev-node.mjs` rodando (porta 8799) com o seed.
 * Cada "set" descreve as cenas da interface daquele momento. A sessão entra como
 * a conta indicada em --token (padrão: o dono, admin).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SET = arg("set", "antes");
const OUT = arg("out", `docs/volanos/redesign/${SET}`);
const BASE = arg("base", "http://127.0.0.1:8799");
const TOKEN = arg("token", "dev-owner-token");
const ONLY = arg("only", "");
const AUDIT = args.includes("--audit");
const EDGE = arg("browser", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
const PORT = 9333;
const SIZES = [{ tag: "1280", w: 1280, h: 800, mobile: false }, { tag: "390", w: 390, h: 844, mobile: true }];

let auditTotal = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cenas por conjunto. `run(page)` leva a tela ao estado a capturar. */
const SCENES = {
  antes: [
    { name: "home", run: async (p) => { await p.wait(800); } },
    {
      name: "chat",
      run: async (p) => {
        await p.eval(`(() => { const f = document.getElementById('home-field'); f.value = 'Qual é a meta de leads da Dique?'; submitHome(); })()`);
        await p.waitFor(`!!document.querySelector('.ex-a') && document.querySelector('.ex-a').textContent.length > 20`, 8000);
        await p.wait(600);
      },
    },
    { name: "memories", run: async (p) => { await p.eval(`switchTab('memories')`); await p.wait(1200); } },
    { name: "admin", run: async (p) => { await p.eval(`switchTab('team')`); await p.wait(1500); } },
  ],
  depois: [],
};
try { const m = await import("./capture-scenes-depois.mjs"); SCENES.depois = m.default; } catch { /* ainda não existe */ }

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method && connect.onEvent) connect.onEvent(msg);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "sb-edge-"));
  const proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(300);
    try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json(); } catch { /* ainda subindo */ }
  }
  if (!target) throw new Error("Edge não respondeu na porta de depuração");
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const problems = [];
  connect.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") problems.push("exceção: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console.error: " + m.params.args.map((a) => a.value || a.description).join(" "));
  };
  const page = {
    eval: async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    wait: sleep,
    waitFor: async (expr, timeout = 6000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (await page.eval(expr).catch(() => false)) return true; await sleep(150); }
      console.warn(`  aviso: condição não satisfeita em ${timeout}ms: ${expr.slice(0, 70)}`);
      return false;
    },
    click: (sel) => page.eval(`document.querySelector(${JSON.stringify(sel)})?.click()`),
    goto: async (path) => { await cdp.send("Page.navigate", { url: BASE + path }); await sleep(900); },
  };

  mkdirSync(OUT, { recursive: true });
  const scenes = (SCENES[SET] || []).filter((s) => !ONLY || s.name === ONLY);
  for (const size of SIZES) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.mobile });
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: size.mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" });
    for (const scene of scenes) {
      // Estado limpo por cena: sessão da conta pedida, nada de rascunhos do passeio anterior.
      await page.goto("/");
      await page.eval(`localStorage.clear(); localStorage.setItem('sb_url', ${JSON.stringify(BASE)}); localStorage.setItem('sb_token', ${JSON.stringify(TOKEN)}); localStorage.setItem('sb_locale', 'pt-BR'); localStorage.setItem('sb_theme', 'light');`);
      await page.goto(scene.path && scene.path.startsWith("/#") ? `/?s=${Date.now()}${scene.path.slice(1)}` : scene.path || "/"); // consulta nova força o recarregamento: só o fragmento mudar não reiniciaria o app
      await page.wait(1500);
      await scene.run(page);
      let shot;
      if (scene.full) {
        const m = await cdp.send("Page.getLayoutMetrics");
        const height = Math.min(Math.ceil(m.cssContentSize.height), 12000);
        shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.w, height, scale: 1 } });
      } else shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const file = join(OUT, `${scene.name}-${size.tag}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`  ${file}`);
      if (AUDIT) {
        const found = await page.eval(readFileSync(new URL("./brand-audit-page.js", import.meta.url), "utf8"));
        auditTotal += found.length;
        for (const f of found) console.warn(`    marca: ${f}`);
      }
      while (problems.length) console.warn(`    ! ${problems.shift()}`);
    }
  }
  if (AUDIT) { console.log(auditTotal ? `Auditoria de marca: ${auditTotal} achados.` : "Auditoria de marca: nenhum achado."); process.exitCode = auditTotal ? 2 : 0; }
  cdp.close();
  proc.kill();
  await sleep(300);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* o Edge ainda segura o perfil */ }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
