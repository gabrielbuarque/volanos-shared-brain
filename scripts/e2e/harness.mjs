/**
 * Harness mínimo para testes ponta a ponta na interface: Edge headless via CDP, sem dependências.
 * Uso: import { withPage } from "./harness.mjs"; await withPage({ token }, async (p) => { ... });
 * Requer `npm run dev:node` rodando (porta 8799). Porta de depuração 9444 (não colide com a das capturas).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BASE = process.env.SB_BASE || "http://127.0.0.1:8799";

function connect(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) onEvent?.(msg);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
  });
}

export async function withPage(opts, fn) {
  const { token = "dev-owner-token", w = 1280, h = 800, mobile = false, port = 9444, locale = "pt-BR" } = opts;
  const dir = mkdtempSync(join(tmpdir(), "sb-e2e-"));
  const proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(300);
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch { /* subindo */ }
  }
  if (!target) throw new Error("Edge não respondeu");
  const problems = [];
  const net = [];
  const cdp = await connect(target.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.exceptionThrown") problems.push("exceção: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console.error: " + m.params.args.map((a) => a.value || a.description).join(" "));
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400) net.push(`${m.params.response.status} ${m.params.response.url.replace(BASE, "")}`);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  const page = {
    problems, net,
    eval: async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    wait: sleep,
    waitFor: async (expr, timeout = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (await page.eval(expr).catch(() => false)) return true; await sleep(120); }
      return false;
    },
    goto: async (path = "/") => { await cdp.send("Page.navigate", { url: BASE + path }); await sleep(900); },
    login: async (t = token) => {
      await page.goto("/");
      await page.eval(`localStorage.clear(); localStorage.setItem('sb_url', ${JSON.stringify(BASE)}); localStorage.setItem('sb_token', ${JSON.stringify(t)}); localStorage.setItem('sb_locale', ${JSON.stringify(locale)});`);
      await page.goto("/");
      await page.waitFor(`!!document.querySelector('.topbar')`, 6000);
    },
    shot: async (file) => {
      mkdirSync(dirname(file), { recursive: true });
      const s = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(s.data, "base64"));
    },
    key: (key, code) => { const vk = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowRight: 39 }[key] || 0; const base = { key, code: code || key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }; return cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }).then(() => cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })); },
    text: () => page.eval(`document.body.innerText`),
    api: (path, init = {}, t = token) => page.eval(`fetch(${JSON.stringify(BASE + path)}, Object.assign({headers:{'Authorization':'Bearer ${t}','Content-Type':'application/json'}}, ${JSON.stringify(init)})).then(async r => ({status:r.status, body: await r.text()}))`),
  };
  try { return await fn(page); }
  finally {
    cdp.close();
    proc.kill();
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* perfil ainda em uso */ }
  }
}
