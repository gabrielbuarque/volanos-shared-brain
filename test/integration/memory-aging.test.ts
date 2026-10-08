/**
 * Memory aging against real SQLite: near-duplicate suggestions, contradiction
 * alerts, compaction of cold notes, manual merge with history, restore, the
 * health tab, and the audit trail. No model is involved anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import { runAgingJob } from "../../src/aging/jobs";
import { hourlySlot } from "../../src/runtime/slots";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const DAY = 86_400_000;
const now = Date.now();
const ctx = { waitUntil: (p: Promise<unknown>) => void p } as unknown as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let company = "";
let ana = { id: "", token: "" };
let bob = { id: "", token: "" };
/** index of an entry's vector -> its nearest neighbours. */
const neighbours = new Map<number, { id: string; score: number }[]>();
let indexOf = new Map<string, number>();

const run = (sql: string, ...args: unknown[]) => sqlite.db.prepare(sql).bind(...args).run();
const rows = async <T = Record<string, any>>(sql: string, ...args: unknown[]) => (await sqlite.db.prepare(sql).bind(...args).all()).results as T[];

async function seed(id: string, content: string, over: { level?: number; ws?: string; actor?: string; tags?: string[]; source?: string; created?: number; updated?: number; accessed?: number | null; dir?: string | null } = {}) {
  const idx = indexOf.size + 1;
  indexOf.set(id, idx);
  await run(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id, recall_count, importance_score, last_accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    id, content, JSON.stringify(over.tags ?? ["atlas"]), over.source ?? "api", over.created ?? now - 400 * DAY + idx, over.updated ?? over.created ?? now - 400 * DAY + idx,
    JSON.stringify([`vec-${id}`]), over.ws ?? company, over.actor ?? ana.id, over.level ?? 12, over.dir ?? null, over.accessed ?? null);
}
const near = (a: string, list: [string, number][]) => neighbours.set(indexOf.get(a)!, list.map(([id, score]) => ({ id, score })));

const config = (over: Record<string, unknown>) => env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(over));
const call = (method: string, path: string, token: string, body?: unknown) => worker.fetch(new Request(`${BASE}${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), env, ctx);
const ADMIN = "test-token";

beforeEach(async () => {
  neighbours.clear();
  indexOf = new Map();
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  const vectors = {
    getByIds: vi.fn().mockImplementation(async (ids: string[]) => ids.map(id => ({ id, values: [indexOf.get(id.replace(/^vec-/, "")) ?? 0, 0, 0], metadata: {} }))),
    query: vi.fn().mockImplementation(async (values: number[]) => ({
      matches: (neighbours.get(values[0]) ?? []).map(n => ({ id: `vec-${n.id}`, score: n.score, metadata: { parentId: n.id } })),
    })),
  };
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(vectors as never) });
  await initializeDatabase(env);
  company = (await ensureTenantBootstrap(env)).companyWorkspaceId;
  const a = await createMember(env, { name: "Ana" });
  const b = await createMember(env, { name: "Bob" });
  ana = { id: a.member.userId, token: a.token };
  bob = { id: b.member.userId, token: b.token };
  await run(`UPDATE users SET clearance_floor = 4 WHERE id = ?`, ana.id);
  await run(`UPDATE users SET clearance_floor = 8 WHERE id = ?`, bob.id);
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

describe("schedule", () => {
  it("gives the export and the weekly passes their own hour on the hourly trigger, and every other hour to the integration sync", () => {
    const at = (iso: string) => hourlySlot(new Date(iso));
    expect(at("2026-10-06T06:30:00Z")).toBe("export");
    expect(at("2026-10-07T06:30:00Z")).toBe("export");
    expect(at("2026-10-04T07:30:00Z")).toBe("aging-dedup"); // a Sunday
    expect(at("2026-10-04T08:30:00Z")).toBe("aging-contradictions");
    expect(at("2026-10-04T09:30:00Z")).toBe("aging-compact");
    expect(at("2026-10-05T07:30:00Z")).toBe("integration-sync"); // a Monday
    expect(at("2026-10-04T12:30:00Z")).toBe("integration-sync");
  });
});

describe("near-duplicates (AGING_DEDUP)", () => {
  beforeEach(async () => {
    await seed("dup-a", "# Atlas kickoff\nO kickoff do Atlas foi definido com a equipe.", { actor: ana.id });
    await seed("dup-b", "# Atlas kickoff\nO kickoff do Atlas foi definido com o time.", { actor: bob.id });
    await seed("other-level", "# Atlas kickoff\nO kickoff do Atlas foi definido com a equipe.", { level: 5 });
    await seed("other-ws", "# Atlas kickoff\nO kickoff do Atlas foi definido.", { ws: "ws-elsewhere" });
    await seed("lower-score", "# Atlas kickoff\nUm texto parecido.");
    near("dup-a", [["dup-b", 0.97], ["other-level", 0.99], ["other-ws", 0.99], ["lower-score", 0.9]]);
    near("dup-b", [["dup-a", 0.97]]);
  });

  it("does nothing while the flag is off", async () => {
    const out = await runAgingJob(env, "dedup");
    expect(out).toMatchObject({ enabled: false, created: 0 });
    expect(await rows(`SELECT * FROM aging_suggestions`)).toEqual([]);
  });

  it("suggests only pairs in the same workspace and level above the threshold, once, and audits as system:aging-dedup", async () => {
    await config({ AGING_DEDUP: "on", AGING_SCAN_BATCH: 100 });
    const first = await runAgingJob(env, "dedup");
    expect(first).toMatchObject({ ok: true, enabled: true, created: 1, cycle_complete: true });
    const sug = await rows(`SELECT kind, a_id, b_id, score, status, owner_id, detail FROM aging_suggestions`);
    expect(sug).toHaveLength(1);
    expect(sug[0]).toMatchObject({ kind: "duplicate", a_id: "dup-a", b_id: "dup-b", status: "open", owner_id: ana.id });
    expect(JSON.parse(sug[0].detail)).toMatchObject({ clearance_level: 12, suggested_keep: "dup-a" });

    expect((await runAgingJob(env, "dedup")).created).toBe(0); // idempotent
    expect(await rows(`SELECT actor_id, event FROM entry_events WHERE event = 'aging_suggested'`)).toEqual([{ actor_id: "system:aging-dedup", event: "aging_suggested" }]);
    expect((await rows(`SELECT job, actor_id, ok FROM job_runs WHERE job = 'aging-dedup' ORDER BY started_at`)).every(r => r.actor_id === "system:aging-dedup" && r.ok === 1)).toBe(true);
    expect(await rows(`SELECT event, actor_id FROM admin_events WHERE event = 'aging_job_run'`)).not.toEqual([]);
  });

  it("changes no memory by itself", async () => {
    await config({ AGING_DEDUP: "on", AGING_SCAN_BATCH: 100 });
    await runAgingJob(env, "dedup");
    const rowsAfter = await rows(`SELECT id, superseded_by, version, content FROM entries ORDER BY id`);
    expect(rowsAfter.every(r => r.superseded_by === null && r.version === 1)).toBe(true);
  });

  it("walks the corpus in batches from a cursor", async () => {
    await config({ AGING_DEDUP: "on", AGING_SCAN_BATCH: 5 });
    const a = await runAgingJob(env, "dedup");
    expect(a.scanned).toBe(5);
    expect(a.cycle_complete).toBe(false);
    const b = await runAgingJob(env, "dedup");
    expect(b.scanned).toBe(0);
    expect(b.cycle_complete).toBe(true);
  });

  describe("resolving a suggestion", () => {
    beforeEach(async () => {
      await config({ AGING_DEDUP: "on", AGING_SCAN_BATCH: 100 });
      await runAgingJob(env, "dedup");
    });
    const sugId = async () => (await rows(`SELECT id FROM aging_suggestions`))[0].id as string;

    it("lists it for the owner and the other author, not for a stranger, and never above the viewer's level", async () => {
      expect(((await (await call("GET", "/memory/suggestions", ana.token)).json()) as any).suggestions).toHaveLength(1);
      expect(((await (await call("GET", "/memory/suggestions", bob.token)).json()) as any).suggestions).toHaveLength(1);
      const stranger = await createMember(env, { name: "Cy" });
      expect(((await (await call("GET", "/memory/suggestions", stranger.token)).json()) as any).suggestions).toHaveLength(0);
      // Ana (floor P4) cannot see a pair at P2.
      await run(`UPDATE entries SET clearance_level = 2 WHERE id IN ('dup-a', 'dup-b')`);
      expect(((await (await call("GET", "/memory/suggestions", ana.token)).json()) as any).suggestions).toHaveLength(0);
      expect((await call("POST", "/memory/suggestions/resolve", ana.token, { id: await sugId(), action: "dismiss" })).status).toBe(404);
    });

    it("merge: the chosen memory stays, the other becomes superseded with a link, nothing is deleted, history keeps the text", async () => {
      const res = await call("POST", "/memory/suggestions/resolve", ADMIN, { id: await sugId(), action: "merge", keep: "dup-a" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "resolved", kept: "dup-a", superseded: "dup-b" });
      const [b] = await rows(`SELECT superseded_by, tags, version, content FROM entries WHERE id = 'dup-b'`);
      expect(b.superseded_by).toBe("dup-a");
      expect(JSON.parse(b.tags)).toContain("status:deprecated");
      expect(b.version).toBe(2);
      expect(b.content).toContain("com o time"); // the text itself is untouched
      expect(await rows(`SELECT version, reason, content FROM entry_versions WHERE entry_id = 'dup-b'`)).toEqual([{ version: 1, reason: "merge-superseded", content: b.content }]);
      expect(((await rows(`SELECT COUNT(*) AS n FROM entries`))[0] as any).n).toBe(5);
      expect(await rows(`SELECT source_id, target_id, type FROM edges WHERE type = 'supersedes'`)).toEqual([{ source_id: "dup-a", target_id: "dup-b", type: "supersedes" }]);
      expect((await rows(`SELECT status, resolution FROM aging_suggestions`))[0]).toEqual({ status: "resolved", resolution: "keep:dup-a" });
      expect((await call("POST", "/memory/suggestions/resolve", ADMIN, { id: await sugId(), action: "merge", keep: "dup-a" })).status).toBe(409);
    });

    it("dismiss keeps both and never suggests the pair again", async () => {
      expect((await call("POST", "/memory/suggestions/resolve", ana.token, { id: await sugId(), action: "dismiss" })).status).toBe(200);
      expect(((await rows(`SELECT COUNT(*) AS n FROM entries WHERE superseded_by IS NOT NULL`))[0] as any).n).toBe(0);
      await run(`DELETE FROM job_runs`);
      await runAgingJob(env, "dedup");
      await run(`UPDATE aging_suggestions SET status = status`);
      expect(((await rows(`SELECT COUNT(*) AS n FROM aging_suggestions`))[0] as any).n).toBe(1);
    });

    it("refuses to retire a canonical memory, a bad keep, and a non-author on a shared memory", async () => {
      await run(`UPDATE entries SET tags = '["atlas","status:canonical"]' WHERE id = 'dup-b'`);
      expect((await call("POST", "/memory/suggestions/resolve", ADMIN, { id: await sugId(), action: "merge", keep: "dup-a" })).status).toBe(409);
      expect((await call("POST", "/memory/suggestions/resolve", ADMIN, { id: await sugId(), action: "merge", keep: "nope" })).status).toBe(400);
      await run(`UPDATE entries SET tags = '["atlas"]' WHERE id = 'dup-b'`);
      // Ana tries to retire Bob's shared memory: only its author or an admin may.
      expect((await call("POST", "/memory/suggestions/resolve", ana.token, { id: await sugId(), action: "merge", keep: "dup-a" })).status).toBe(403);
    });

    it("a superseded memory drops out of recall but can be restored", async () => {
      await call("POST", "/memory/suggestions/resolve", ADMIN, { id: await sugId(), action: "merge", keep: "dup-a" });
      const hit = async () => ((await (await call("GET", "/recall?query=kickoff&topK=10", ADMIN)).json()) as any).results?.map((r: any) => r.id) ?? [];
      expect(await hit()).not.toContain("dup-b");
      const versions = await (await call("GET", "/entry/versions?id=dup-b", ADMIN)).json() as any;
      expect(versions.versions.map((v: any) => v.version)).toEqual([1]);
      const res = await call("POST", "/entry/restore", ADMIN, { id: "dup-b", version: 1 });
      expect(res.status).toBe(200);
      const [b] = await rows(`SELECT superseded_by, version, tags FROM entries WHERE id = 'dup-b'`);
      expect(b).toMatchObject({ superseded_by: null, version: 3 });
      expect(JSON.parse(b.tags)).not.toContain("status:deprecated");
      expect(await hit()).toContain("dup-b");
    });
  });
});

describe("contradictions (AGING_CONTRADICTIONS)", () => {
  beforeEach(async () => {
    await seed("c-a", "# Orçamento do Atlas\nO orçamento aprovado do projeto Atlas é R$ 4,2 milhões. O cliente Acme assinou o contrato.", { actor: ana.id, tags: ["atlas", "status:canonical"] });
    await seed("c-b", "# Orçamento do Atlas\nO orçamento aprovado do projeto Atlas é R$ 5 milhões. O cliente Acme assinou o contrato.", { actor: bob.id, source: "github", updated: now - 10 * DAY });
    await seed("c-same", "# Orçamento do Atlas\nO orçamento aprovado do projeto Atlas é R$ 4,2 milhões. A Acme assinou o contrato Atlas.", { actor: bob.id });
    await seed("c-untagged", "# Outra coisa\nO orçamento aprovado do projeto Zeta é R$ 9 milhões.", { tags: ["zeta"] });
    near("c-a", [["c-b", 0.9], ["c-same", 0.92], ["c-untagged", 0.86]]);
  });

  it("raises an alert for diverging figures about the same subject, and none for agreement or another subject", async () => {
    await config({ AGING_CONTRADICTIONS: "on", AGING_SCAN_BATCH: 100 });
    const out = await runAgingJob(env, "contradictions");
    expect(out).toMatchObject({ ok: true, enabled: true, created: 1 });
    const [s] = await rows(`SELECT kind, a_id, b_id, owner_id, status, detail FROM aging_suggestions`);
    const detail = JSON.parse(s.detail);
    expect(s).toMatchObject({ kind: "contradiction", a_id: "c-a", b_id: "c-b", status: "open" });
    expect(detail.divergences[0]).toMatchObject({ aValues: ["R$ 4,2 milhões"], bValues: ["R$ 5 milhões"] });
    expect(detail.shared_tags).toContain("atlas");
  });

  it("sends the alert to the author of the canonical memory, even against a better source and newer text, and changes nothing", async () => {
    await config({ AGING_CONTRADICTIONS: "on", AGING_SCAN_BATCH: 100 });
    await runAgingJob(env, "contradictions");
    const [s] = await rows(`SELECT owner_id, detail FROM aging_suggestions`);
    expect(s.owner_id).toBe(ana.id);
    expect(JSON.parse(s.detail).precedence).toEqual({ winner: "c-a", rule: "canonical" });
    expect(await rows(`SELECT id FROM entries WHERE superseded_by IS NOT NULL`)).toEqual([]);
    expect((await rows(`SELECT tags FROM entries WHERE id = 'c-a'`))[0].tags).toContain("status:canonical");
    expect((await rows(`SELECT tags FROM entries WHERE id = 'c-b'`))[0].tags).not.toContain("status:canonical");
  });

  it("without a canonical, the better source wins and its author is the owner", async () => {
    await run(`UPDATE entries SET tags = '["atlas"]' WHERE id = 'c-a'`);
    await config({ AGING_CONTRADICTIONS: "on", AGING_SCAN_BATCH: 100 });
    await runAgingJob(env, "contradictions");
    const [s] = await rows(`SELECT owner_id, detail FROM aging_suggestions`);
    expect(JSON.parse(s.detail).precedence).toEqual({ winner: "c-b", rule: "source" });
    expect(s.owner_id).toBe(bob.id);
  });
});

describe("compaction of cold episodic notes (AGING_COMPACT)", () => {
  const longNote = [
    "# Reunião com a Acme",
    "Todos chegaram no horário e o café estava ótimo. Falamos um pouco sobre o clima e sobre o fim de semana prolongado.",
    "Decidimos aprovar o orçamento de R$ 4,2 milhões para o projeto Atlas.",
    "A conversa seguiu sobre assuntos gerais, sem nada a registrar, durante um bom tempo, com várias pessoas comentando outros temas do dia.",
    "O kickoff ficou marcado para 10/03/2026 e o plano está em plano-atlas.pdf.",
    "Depois disso o grupo seguiu para o almoço e a reunião foi encerrada sem outras observações relevantes, com todos voltando às suas mesas.",
    "Ficou combinado que o cliente envia o contrato assinado até 15/03/2026.",
  ].join("\n") + "\n" + "Enchimento de conversa sem importância. ".repeat(14);

  beforeEach(async () => {
    await seed("cold", longNote, { tags: ["atlas", "kind:episodic"], actor: ana.id, level: 6 });
    await seed("warm", longNote, { tags: ["atlas", "kind:episodic"], accessed: now - 5 * DAY });
    await seed("semantic", longNote, { tags: ["atlas", "kind:semantic"] });
    await seed("canon", longNote, { tags: ["atlas", "kind:episodic", "status:canonical"] });
    await seed("tiny", "# Nota curta\nEm 10/03/2026 decidimos.", { tags: ["kind:episodic"] });
  });

  it("is off by default", async () => {
    expect((await runAgingJob(env, "compact")).enabled).toBe(false);
    expect((await rows(`SELECT content FROM entries WHERE id = 'cold'`))[0].content).toBe(longNote);
  });

  it("compacts only cold, non-canonical episodic notes; the original stays in history at its level; restore brings it back", async () => {
    await config({ AGING_COMPACT: "on" });
    const out = await runAgingJob(env, "compact");
    expect(out).toMatchObject({ ok: true, created: 1 });
    const [cold] = await rows(`SELECT content, tags, version, compacted_at, clearance_level FROM entries WHERE id = 'cold'`);
    expect(cold.content).toContain("Resumo extrativo");
    expect(cold.content).toContain("R$ 4,2 milhões");
    expect(cold.content).not.toContain("café estava ótimo");
    expect(JSON.parse(cold.tags)).toContain("compacted");
    expect(cold).toMatchObject({ version: 2, clearance_level: 6 });
    expect(cold.compacted_at).toBeGreaterThan(0);
    // The others are untouched.
    for (const id of ["warm", "semantic", "canon", "tiny"]) expect((await rows(`SELECT content FROM entries WHERE id = ?`, id))[0].content === longNote || id === "tiny").toBe(true);
    // Original preserved, with the level it had.
    expect(await rows(`SELECT version, reason, actor_id, clearance_level, content FROM entry_versions WHERE entry_id = 'cold'`)).toEqual([
      { version: 1, reason: "compact", actor_id: "system:aging-compact", clearance_level: 6, content: longNote },
    ]);
    expect(await rows(`SELECT actor_id, event FROM entry_events WHERE event = 'compacted'`)).toEqual([{ actor_id: "system:aging-compact", event: "compacted" }]);

    // Not compacted twice.
    expect((await runAgingJob(env, "compact")).created).toBe(0);

    // The owner restores the original.
    const res = await call("POST", "/entry/restore", ana.token, { id: "cold", version: 1 });
    expect(res.status).toBe(200);
    const [back] = await rows(`SELECT content, tags, compacted_at, version FROM entries WHERE id = 'cold'`);
    expect(back.content).toBe(longNote);
    expect(JSON.parse(back.tags)).not.toContain("compacted");
    expect(back).toMatchObject({ compacted_at: null, version: 3 });
    expect(await rows(`SELECT version, reason FROM entry_versions WHERE entry_id = 'cold' ORDER BY version`)).toEqual([{ version: 1, reason: "compact" }, { version: 2, reason: "restore" }]);
  });

  it("a version above the caller's level is never shown or restorable", async () => {
    await config({ AGING_COMPACT: "on" });
    await runAgingJob(env, "compact");
    await run(`UPDATE entries SET clearance_level = 12 WHERE id = 'cold'`);
    await run(`UPDATE entry_versions SET clearance_level = 2 WHERE entry_id = 'cold'`);
    const versions = await (await call("GET", "/entry/versions?id=cold", ana.token)).json() as any;
    expect(versions.versions).toEqual([]);
    expect((await call("POST", "/entry/restore", ana.token, { id: "cold", version: 1 })).status).toBe(404);
  });
});

describe("memory health tab", () => {
  it("counts what is waiting, reports the flags, and lists the latest jobs; admin only", async () => {
    await seed("h1", "# Atlas\nO orçamento do Atlas é R$ 4,2 milhões.", { actor: ana.id });
    await seed("h2", "# Atlas\nO orçamento do Atlas é R$ 4,2 milhões.", { actor: ana.id });
    await seed("h3", "# Frio\nNota fria.", { tags: ["kind:episodic"] });
    await run(`UPDATE entries SET access_count = 7, last_accessed_at = ? WHERE id = 'h1'`, now);
    near("h1", [["h2", 0.98]]);
    await config({ AGING_DEDUP: "on", AGING_SCAN_BATCH: 100 });
    await runAgingJob(env, "dedup");
    expect((await call("GET", "/admin/memory-health", bob.token)).status).toBe(403);
    const body = await (await call("GET", "/admin/memory-health", ADMIN)).json() as any;
    expect(body.flags).toEqual({ dedup: true, contradictions: false, compact: false });
    expect(body.health).toMatchObject({ duplicates_open: 1, contradictions_open: 0, superseded: 0, compacted: 0 });
    expect(body.health.cold_memories).toBeGreaterThanOrEqual(2);
    expect(body.health.most_used[0]).toMatchObject({ id: "h1", access_count: 7 });
    expect(body.jobs.map((j: any) => j.job)).toContain("aging-dedup");
  });

  it("lets an admin run a pass by hand only when its switch is on", async () => {
    const off = await (await call("POST", "/admin/aging/run", ADMIN, { job: "dedup" })).json() as any;
    expect(off).toMatchObject({ enabled: false });
    expect((await call("POST", "/admin/aging/run", ADMIN, { job: "nope" })).status).toBe(400);
    await config({ AGING_DEDUP: "on" });
    const on = await (await call("POST", "/admin/aging/run", ADMIN, { job: "dedup" })).json() as any;
    expect(on).toMatchObject({ ok: true, enabled: true });
  });
});
