/**
 * Servidor de desenvolvimento em Node: roda o MESMO Worker (src/index.ts) sobre
 * SQLite em memória, serve public/ e carrega o seed de demonstração.
 *
 * Existe porque o `wrangler dev` (workerd) não sobe em alguns Windows
 * ("spawn UNKNOWN"). A IA é SIMULADA: o texto das respostas vem do próprio
 * contexto recuperado, só para exercitar a interface. Nunca use isto em produção.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import worker from "../../src/index";
import { initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeSqliteD1 } from "../../test/helpers/sqlite-d1";
// @ts-expect-error plain ESM script without types
import { demoSeedSql, DEMO_USERS } from "../seed-demo-volanos.mjs";

const PORT = Number(process.env.PORT || 8799);
const OWNER_TOKEN = process.env.DEV_OWNER_TOKEN || "dev-owner-token";
const PUBLIC_DIR = resolve(process.cwd(), "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

/** Resposta simulada: primeira fonte como frase-resumo, as demais como pontos, tudo citado. */
function fakeAnswer(userMessage: string): string {
  const block = userMessage.split("Relevant memories:")[1] ?? userMessage.split("Fontes:")[1] ?? "";
  const items: { n: number; body: string }[] = [];
  let cur: { n: number; body: string } | null = null;
  for (const line of block.split("\n")) {
    const m = line.match(/^(\d{1,2})\. (.*)$/);
    if (m) { cur = { n: Number(m[1]), body: m[2] }; items.push(cur); }
    else if (cur && line.trim()) cur.body += " " + line.trim();
  }
  if (!items.length) return "Não encontrei isso nas fontes.";
  const clean = (s: string) => s.replace(/^\[[^\]]*\]\s*(\([^)]*\)\s*)?(\[[^\]]*\]\s*)*/, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const first = clean(items[0].body).split(/(?<=[.!?])\s/)[0];
  const rest = items.slice(0, 4).map((i) => `- ${clean(i.body).slice(0, 200)} [${i.n}]`).join("\n");
  return `${first} [${items[0].n}]\n\n${rest}`;
}

function sse(text: string): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const part of text.match(/[\s\S]{1,24}/g) ?? []) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ response: part })}\n\n`));
        await new Promise((r) => setTimeout(r, 15));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

const ai = {
  run: async (model: string, input: any) => {
    if (String(model).includes("bge")) return { data: (Array.isArray(input?.text) ? input.text : [input?.text]).map(() => new Array(384).fill(0.1)) };
    const user = [...(input?.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
    return sse(fakeAnswer(String(user)));
  },
};

const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string) => { kvStore.set(k, String(v)); },
  delete: async (k: string) => { kvStore.delete(k); },
  list: async (o: { prefix?: string } = {}) => ({ keys: [...kvStore.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).map((name) => ({ name })), list_complete: true, cacheStatus: null }),
};
const vectorize = {
  query: async () => ({ matches: [] }), insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [], describe: async () => ({}),
};

const sqlite = makeSqliteD1();
const env: any = { DB: sqlite.db, AI: ai, OAUTH_KV: kv, VECTORIZE: vectorize, AUTH_TOKEN: OWNER_TOKEN, VECTORIZE_GRACE_MS: "300000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); }, passThroughOnException() {} };

await initializeDatabase(env);
await ensureTenantBootstrap(env);
await sqlite.db.exec(demoSeedSql());

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const looksStatic = req.method === "GET" && (url.pathname === "/" || /^\/(css|js|fonts|assets)\//.test(url.pathname) || /\.[a-z0-9]+$/i.test(url.pathname));
    if (looksStatic) {
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[\\/]+/, "");
      const file = join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR)) {
        try {
          const buf = await readFile(file);
          res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
          res.end(buf);
          return;
        } catch { /* cai para o Worker */ }
      }
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const hasBody = body && req.method !== "GET" && req.method !== "HEAD";
    const r = await worker.fetch(new Request(url, { method: req.method, headers, body: hasBody ? body : undefined }), env, ctx);
    const out = Buffer.from(await r.arrayBuffer());
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h);
    res.end(out);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Shared Brain (dev em Node, IA simulada) em http://127.0.0.1:${PORT}`);
  console.log(`  dono (admin, P0): ${OWNER_TOKEN}`);
  for (const u of DEMO_USERS) console.log(`  P${u.floor} ${u.name}: ${u.token}`);
});
