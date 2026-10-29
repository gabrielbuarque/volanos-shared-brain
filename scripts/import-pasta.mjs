#!/usr/bin/env node
/**
 * Importa uma pasta local (por exemplo, uma pasta do Google Drive baixada ou
 * sincronizada) para o Shared Brain, em ondas pequenas e classificadas pelo Jev.
 *
 *   node scripts/import-pasta.mjs <pasta> --dry-run              classifica e mostra, não grava
 *   node scripts/import-pasta.mjs <pasta> --limite 10            grava só os 10 primeiros arquivos novos
 *   node scripts/import-pasta.mjs <pasta> --limite 30 --vetorizar
 *
 * Opções:
 *   --base <url>      padrão https://second-brain.gabriel-fde.workers.dev
 *   --lote <n>        arquivos por chamada (padrão 5; o Worker aceita até 100)
 *   --limite <n>      máximo de arquivos NOVOS nesta onda (padrão: todos)
 *   --dry-run         só classifica (nada é gravado e o manifesto não muda)
 *   --vetorizar       depois de gravar, chama /vectorize-pending até zerar
 *   --manifesto <f>   arquivo de controle (padrão <pasta>/.import-manifesto.json)
 *
 * O token do dono vem de AUTH_TOKEN em .dev.vars (ou da variável SB_TOKEN) e nunca é impresso.
 * O manifesto guarda o hash de cada arquivo já enviado: rodar de novo pula o que não mudou.
 * Aceita .md, .txt, .csv, .json e .docx (o que o Drive entrega ao baixar uma pasta de Google Docs).
 * PDF e planilhas ainda não: exporte como texto ou Markdown.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const pasta = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--dry-run", "--vetorizar"].includes(args[i - 1])));
if (!pasta) { console.error("Uso: node scripts/import-pasta.mjs <pasta> [--dry-run] [--limite N] [--lote N] [--vetorizar]"); process.exit(1); }

const BASE = (opt("base", "https://second-brain.gabriel-fde.workers.dev")).replace(/\/$/, "");
const LOTE = Number(opt("lote", 5));
const LIMITE = opt("limite") ? Number(opt("limite")) : Infinity;
const DRY = flag("dry-run");
const ROOT = resolve(pasta);
const MANIFESTO = resolve(opt("manifesto", join(ROOT, ".import-manifesto.json")));
const EXT = new Set([".md", ".txt", ".csv", ".json", ".docx"]);
const MAX_CHARS = 250_000;

function token() {
  if (process.env.SB_TOKEN) return process.env.SB_TOKEN;
  const dev = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");
  const line = readFileSync(dev, "utf8").split(/\r?\n/).find((l) => l.startsWith("AUTH_TOKEN="));
  if (!line) throw new Error("AUTH_TOKEN não encontrado em .dev.vars; defina SB_TOKEN");
  return line.slice("AUTH_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
}
const TOKEN = token();
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { ok: false, error: txt.slice(0, 200) }; }
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  return { status: r.status, ...j };
};

function* andar(dir) {
  for (const nome of readdirSync(dir).sort()) {
    if (nome.startsWith(".")) continue;
    const p = join(dir, nome);
    const st = statSync(p);
    if (st.isDirectory()) yield* andar(p);
    else if (EXT.has(extname(nome).toLowerCase())) yield p;
  }
}
/** .docx → Markdown simples (títulos, listas, parágrafos). Só Node, sem dependências. */
function docxParaTexto(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip inválido");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    const metodo = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), nome = buf.toString("utf8", p + 46, p + 46 + nl);
    if (nome === "word/document.xml") {
      const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
      const dados = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
      const xml = (metodo === 8 ? inflateRawSync(dados) : dados).toString("utf8");
      const dec = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => {
        const par = m[0];
        const txt = dec([...par.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((t) => (t[1] !== undefined ? t[1] : " ")).join(""));
        if (!txt.trim()) return "";
        const h = par.match(/<w:pStyle w:val="(?:Heading|Título|Titulo)(\d)"/i);
        if (h) return "#".repeat(Math.min(6, Number(h[1]))) + " " + txt.trim();
        if (/<w:pStyle w:val="Title"/i.test(par)) return "# " + txt.trim();
        if (/<w:numPr>/.test(par)) return "- " + txt.trim();
        return txt.trim();
      }).filter((l, i, a) => l || a[i - 1]).join("\n\n").replace(/\n\n(- )/g, "\n$1");
    }
    p += 46 + nl + el + cl;
  }
  throw new Error("word/document.xml não encontrado");
}
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const manifesto = existsSync(MANIFESTO) ? JSON.parse(readFileSync(MANIFESTO, "utf8")) : {};
const todos = [...andar(ROOT)].map((p) => {
  const content = extname(p).toLowerCase() === ".docx" ? (() => { try { return docxParaTexto(readFileSync(p)); } catch (e) { console.log("  aviso: não consegui ler", p, e.message); return ""; } })() : readFileSync(p, "utf8");
  const path = relative(ROOT, p).split("\\").join("/");
  return { path, content, h: hash(content), mtime: statSync(p).mtimeMs };
});
const invalidos = todos.filter((f) => !f.content.trim() || f.content.includes("\0") || f.content.length > MAX_CHARS);
const validos = todos.filter((f) => !invalidos.includes(f));
const novos = validos.filter((f) => manifesto[f.path] !== f.h).slice(0, LIMITE);

console.log(`Pasta: ${ROOT}`);
console.log(`Arquivos: ${todos.length} | já enviados e iguais: ${validos.length - validos.filter((f) => manifesto[f.path] !== f.h).length} | novos nesta onda: ${novos.length}${invalidos.length ? ` | ignorados (vazio/grande): ${invalidos.map((f) => f.path).join(", ")}` : ""}`);
console.log(DRY ? "MODO DRY-RUN: nada será gravado.\n" : "");

const total = { published: 0, quarantined: 0, flagged_for_review: 0, by_level: {} };
const falhas = [];
for (let i = 0; i < novos.length; i += LOTE) {
  const lote = novos.slice(i, i + LOTE);
  const res = await api("POST", "/bulk-ingest", {
    workspace: "company", dry_run: DRY,
    files: lote.map((f) => ({ path: f.path, content: f.content, source: "drive", created_at: Math.round(f.mtime) })),
  });
  if (!res.ok) { falhas.push(...lote.map((f) => `${f.path}: ${res.error ?? res.status}`)); console.log(`  lote ${i / LOTE + 1}: FALHOU (${res.error ?? res.status})`); continue; }
  total.published += res.published ?? 0; total.quarantined += res.quarantined ?? 0; total.flagged_for_review += res.flagged_for_review ?? 0;
  for (const [k, v] of Object.entries(res.by_level ?? {})) total.by_level[k] = (total.by_level[k] ?? 0) + v;
  if (!DRY) for (const f of lote) manifesto[f.path] = f.h;
  console.log(`  lote ${i / LOTE + 1}/${Math.ceil(novos.length / LOTE)}: ${lote.length} arquivos, publicados ${res.published ?? 0}, fila ${res.quarantined ?? 0}, revisar ${res.flagged_for_review ?? 0}`);
  if (DRY && res.chunks) for (const c of res.chunks.slice(0, 6)) console.log(`      P${c.level} ${c.outcome} (${Number(c.confidence ?? 0).toFixed(2)}) ${c.path} › ${c.section}`);
}
if (!DRY) writeFileSync(MANIFESTO, JSON.stringify(manifesto, null, 2));

console.log("\nResumo da onda");
console.log(`  publicados: ${total.published} | em quarentena: ${total.quarantined} | marcados para revisão: ${total.flagged_for_review}`);
console.log("  por nível:", Object.entries(total.by_level).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([k, v]) => `${k}=${v}`).join(" ") || "—");
if (falhas.length) { console.log("  falhas:"); falhas.forEach((f) => console.log("   -", f)); }

if (flag("vetorizar") && !DRY) {
  console.log("\nVetorizando…");
  for (let n = 0; n < 200; n++) {
    const r = await api("POST", "/vectorize-pending", {});
    const restante = r.remaining ?? r.pending ?? 0;
    console.log(`  restante: ${restante}`);
    if (!restante) break;
  }
}
