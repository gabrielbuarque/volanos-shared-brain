#!/usr/bin/env node
/**
 * Seed de demonstração do Shared Brain da Volanos. SOMENTE LOCAL.
 *
 * Gera dados sintéticos: nenhum cliente real. Dois clientes ("Dique" e "Aurora
 * Têxtil"), conteúdo em P0, P6, P8 e P12, um par de fontes que se contradizem
 * (mesma meta, valores diferentes) e uma fonte com mais de 180 dias.
 *
 * Um cliente é um diretório do Shared Brain (`brain_directories`). O escopo de
 * cliente se soma ao nível P e à ACL de diretório; nunca os substitui.
 *
 * Uso:
 *   node scripts/seed-demo-volanos.mjs --out demo.sql      grava o SQL
 *   node scripts/seed-demo-volanos.mjs --apply             aplica no D1 LOCAL (wrangler d1 execute --local)
 *
 * Antes de --apply, suba o Worker uma vez (npm run dev e abra /health) para que
 * o banco local seja criado e o tenant, inicializado. O script recusa banco remoto.
 * O mesmo SQL é carregado pelo teste de isolamento (test/integration/demo-seed.test.ts).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DAY = 86_400_000;

export const DEMO_COMPANY_SUBSELECT = "(SELECT id FROM workspaces WHERE kind = 'company' ORDER BY created_at LIMIT 1)";

/** Pessoas de demonstração. Os tokens são fixos de propósito: só valem em banco local. */
export const DEMO_USERS = [
  { id: "demo-usr-p0", name: "Demo Diretoria", email: "diretoria@demo.volanos.invalid", role: "member", floor: 0, token: "demo-token-p0-diretoria" },
  { id: "demo-usr-p6", name: "Demo Gerência", email: "gerencia@demo.volanos.invalid", role: "member", floor: 6, token: "demo-token-p6-gerencia" },
  { id: "demo-usr-p8", name: "Demo Time", email: "time@demo.volanos.invalid", role: "member", floor: 8, token: "demo-token-p8-time" },
];

export const DEMO_DIRECTORIES = [
  { id: "demo-dir-dique", path: "clientes/dique", name: "Dique", ownerId: "demo-usr-p0" },
  { id: "demo-dir-aurora", path: "clientes/aurora-textil", name: "Aurora Têxtil", ownerId: "demo-usr-p6" },
];

/** days = idade em dias do último update; created = idade da criação. */
function entries() {
  const dique = "demo-dir-dique";
  const aurora = "demo-dir-aurora";
  return [
    {
      id: "demo-dique-p0-margem", dir: dique, level: 0, author: "demo-usr-p0", source: "drive", path: "Financeiro/margem-dique.md", days: 40, created: 120,
      tags: ["dique", "financeiro"],
      content: "# Margem do contrato Dique\nA margem líquida do contrato Dique é de 31%. O contrato vale R$ 480 mil por mês. O cliente não vê esses números.",
    },
    {
      id: "demo-dique-p6-escopo", dir: dique, level: 6, author: "demo-usr-p6", source: "drive", path: "Propostas/dique-escopo-2026.md", days: 30, created: 90,
      tags: ["dique", "proposta", "approved"],
      content: "# Escopo acordado com a Dique\nO escopo cobre direção de marketing, funil de vendas para construtoras e relatório mensal. O prazo é de 12 meses. O reajuste anual segue o IPCA.",
    },
    {
      id: "demo-dique-p8-promessas", dir: dique, level: 8, author: "demo-usr-p8", source: "calendar", path: "Reunioes/dique-promessas.md", days: 18, created: 60,
      tags: ["dique", "compromisso", "approved"],
      content: "# Compromissos assumidos com a Dique\nPrometemos o primeiro relatório mensal até o dia 5 de cada mês. Prometemos revisar o funil de construtoras em 60 dias.",
    },
    {
      id: "demo-dique-p12-resumo", dir: dique, level: 12, author: "demo-usr-p0", source: "drive", path: "Clientes/dique-resumo.md", days: 25, created: 200,
      tags: ["dique", "resumo", "status:canonical"],
      content: "# Resumo da Dique\nA Dique é uma rede de materiais de construção com 42 lojas no Nordeste. Atende construtoras pequenas e médias. O decisor de marketing é o diretor comercial.",
    },
    {
      id: "demo-dique-p12-ata", dir: dique, level: 12, author: "demo-usr-p8", source: "calendar", path: "Reunioes/dique-ata-agosto.md", days: 55, created: 55,
      tags: ["dique", "reunião", "meta"],
      content: "# Ata da reunião com a Dique\nA meta de leads qualificados da Dique é de 1.200 leads por mês.",
    },
    {
      id: "demo-dique-p12-planilha", dir: dique, level: 12, author: "demo-usr-p6", source: "drive", path: "Metas/dique-metas-trimestre.md", days: 20, created: 20,
      tags: ["dique", "meta", "status:draft"],
      content: "# Planilha de metas do trimestre\nA meta de leads qualificados da Dique é de 900 leads por mês.",
    },
    {
      id: "demo-dique-p12-crm", dir: dique, level: 12, author: "demo-usr-p8", source: "notion", path: "Clientes/dique-crm.md", days: 410, created: 420,
      tags: ["dique", "crm"],
      content: "# Stack de CRM da Dique\nA Dique usa o HubSpot como CRM desde março de 2025. A integração com o ERP é manual.",
    },
    {
      id: "demo-aurora-p0-margem", dir: aurora, level: 0, author: "demo-usr-p0", source: "drive", path: "Financeiro/margem-aurora.md", days: 35, created: 100,
      tags: ["aurora", "financeiro"],
      content: "# Margem do contrato Aurora\nA margem líquida do contrato Aurora é de 24%. O contrato vale R$ 210 mil por mês. O cliente não vê esses números.",
    },
    {
      id: "demo-aurora-p6-escopo", dir: aurora, level: 6, author: "demo-usr-p6", source: "drive", path: "Propostas/aurora-escopo.md", days: 28, created: 70,
      tags: ["aurora", "proposta", "approved"],
      content: "# Escopo acordado com a Aurora Têxtil\nO escopo cobre posicionamento de marca, canal de representantes e relatório mensal. O prazo é de 6 meses.",
    },
    {
      id: "demo-aurora-p12-resumo", dir: aurora, level: 12, author: "demo-usr-p0", source: "drive", path: "Clientes/aurora-resumo.md", days: 22, created: 150,
      tags: ["aurora", "resumo", "status:canonical"],
      content: "# Resumo da Aurora Têxtil\nA Aurora Têxtil fabrica tecidos de algodão em 3 fábricas. Vende para confecções e para lojas de revenda. A decisão de marketing é da diretora de vendas.",
    },
    {
      id: "demo-aurora-p12-meta", dir: aurora, level: 12, author: "demo-usr-p6", source: "drive", path: "Metas/aurora-metas.md", days: 15, created: 15,
      tags: ["aurora", "meta"],
      content: "# Metas da Aurora Têxtil\nA meta de leads qualificados da Aurora é de 300 leads por mês.",
    },
    {
      id: "demo-interno-p12-precos", dir: null, level: 9, author: "demo-usr-p0", source: "drive", path: "Interno/como-cotamos.md", days: 45, created: 160,
      tags: ["interno", "proposta"],
      content: "# Como cotamos uma proposta\nO preço base de uma proposta de direção de marketing parte de R$ 35 mil por mês. O reajuste anual segue o IPCA.",
    },
    {
      id: "demo-interno-p0-socios", dir: null, level: 0, author: "demo-usr-p0", source: "drive", path: "Interno/socios.md", days: 50, created: 160,
      tags: ["interno", "financeiro"],
      content: "# Distribuição entre sócios\nA distribuição de lucros entre os sócios segue a divisão acordada no contrato social de 2024.",
    },
  ];
}

export function buildDemoSeed(now = Date.now()) {
  return {
    users: DEMO_USERS.map((u) => ({ ...u, tokenHash: createHash("sha256").update(u.token).digest("hex") })),
    directories: DEMO_DIRECTORIES.map((d) => ({ ...d, createdAt: now - 300 * DAY })),
    entries: entries().map((e) => ({
      ...e,
      createdAt: now - e.created * DAY,
      updatedAt: now - e.days * DAY,
    })),
    // O par de metas que se contradizem, como a rotina semanal de contradições o registraria.
    contradictions: [{
      id: "demo-contradiction-dique-leads", a: "demo-dique-p12-ata", b: "demo-dique-p12-planilha", ownerId: "demo-usr-p0",
      detail: { overlap: 1, a_values: ["1.200 leads"], b_values: ["900 leads"], metric: "meta de leads qualificados" },
      createdAt: now - 10 * DAY,
    }],
  };
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** SQL idempotente (INSERT OR REPLACE). O workspace da empresa entra por subselect. */
export function demoSeedSql(now = Date.now()) {
  const seed = buildDemoSeed(now);
  const company = DEMO_COMPANY_SUBSELECT;
  const out = ["-- Shared Brain Volanos: seed de demonstração. SOMENTE LOCAL. Dados sintéticos."];
  for (const u of seed.users) {
    const ws = `demo-ws-${u.id.slice(9)}`;
    out.push(
      `INSERT OR REPLACE INTO users (id, name, email, role, token_hash, suspended, created_at, clearance_floor, direct_publish, approval_status) VALUES (${q(u.id)}, ${q(u.name)}, ${q(u.email)}, ${q(u.role)}, ${q(u.tokenHash)}, 0, ${now - 300 * DAY}, ${u.floor}, 0, 'active');`,
      `INSERT OR REPLACE INTO workspaces (id, kind, name, created_at) VALUES (${q(ws)}, 'personal', ${q(u.name)}, ${now - 300 * DAY});`,
      `INSERT OR REPLACE INTO memberships (user_id, workspace_id, created_at) VALUES (${q(u.id)}, ${q(ws)}, ${now - 300 * DAY});`,
      `INSERT OR REPLACE INTO memberships (user_id, workspace_id, created_at) VALUES (${q(u.id)}, ${company}, ${now - 300 * DAY});`,
    );
  }
  for (const d of seed.directories) {
    out.push(`INSERT OR REPLACE INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at) VALUES (${q(d.id)}, ${company}, NULL, ${q(d.name)}, ${q(d.path)}, 12, ${q(d.ownerId)}, ${d.createdAt});`);
  }
  for (const e of seed.entries) {
    out.push(
      `INSERT OR REPLACE INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id, source_path, recall_count, importance_score) VALUES (${q(e.id)}, ${q(e.content)}, ${q(JSON.stringify(e.tags))}, ${q(e.source)}, ${e.createdAt}, ${e.updatedAt}, '[]', ${company}, ${q(e.author)}, ${e.level}, ${q(e.dir)}, ${q(e.path)}, 0, 0);`,
    );
  }
  for (const c of seed.contradictions) {
    out.push(`INSERT OR REPLACE INTO aging_suggestions (id, kind, workspace_id, a_id, b_id, score, detail, owner_id, status, created_at) VALUES (${q(c.id)}, 'contradiction', ${company}, ${q(c.a)}, ${q(c.b)}, 1, ${q(JSON.stringify(c.detail))}, ${q(c.ownerId)}, 'open', ${c.createdAt});`);
  }
  return out.join("\n") + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const sql = demoSeedSql();
  const out = arg("out");
  if (out) {
    writeFileSync(out, sql, "utf8");
    console.log(`SQL gravado em ${out}`);
  }
  if (args.includes("--apply")) {
    if (args.includes("--remote")) {
      console.error("Recusado: o seed de demonstração só roda em banco local.");
      process.exit(1);
    }
    const tmp = out || join(tmpdir(), "volanos-demo-seed.sql");
    if (!out) writeFileSync(tmp, sql, "utf8");
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "second-brain-db", "--local", `--file=${tmp}`], { stdio: "inherit", shell: true });
    process.exit(r.status ?? 1);
  }
  if (!out && !args.includes("--apply")) {
    console.log("Informe --out <arquivo.sql> ou --apply (banco local).");
    console.log("Pessoas de demonstração (tokens válidos só em banco local):");
    for (const u of DEMO_USERS) console.log(`  P${u.floor}  ${u.name}  ${u.token}`);
  }
}

if (process.argv[1] && /seed-demo-volanos.mjs$/.test(process.argv[1])) main();
