/**
 * The Jev reranker inside the real recall pipeline: it runs after the permission
 * filter, so the grader only ever sees what the caller may read; it reorders; and
 * it can never make a search fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const OLD = Date.now() - 400 * 86400000;
let sqlite: SqliteD1;
let env: Env;
let token = "";
let company = "";
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const run = (sql: string, ...args: unknown[]) => sqlite.db.prepare(sql).bind(...args).run();
function seed(id: string, content: string, level: number) {
  return run(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, recall_count, importance_score)
     VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, 'owner', ?, 0, 0)`, id, content, OLD, OLD, company, level);
}
const jevReply = (grades: Record<string, number>) => ({
  ok: true, status: 200,
  json: async () => ({ answers: Object.fromEntries(Object.entries(grades).map(([k, v]) => [k, { probabilities: { "1.0": v, "0.0": 1 - v }, confidence: 1 }])) }),
}) as Response;
const recall = async (query = "plan") => (await worker.fetch(new Request(`${BASE}/recall?query=${query}&topK=5`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx)).json() as Promise<any>;

async function setConfig(over: Record<string, unknown>) {
  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(over));
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  const vec = new Array(384).fill(0.1);
  const matches = ["p0", "p7a", "p7b"].map((id, i) => ({ id, score: 0.9 - i * 0.01, metadata: { parentId: id }, values: vec }));
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), TYPESAFE_API_KEY: "key",
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
  });
  await initializeDatabase(env);
  company = (await ensureTenantBootstrap(env)).companyWorkspaceId;
  const bob = await createMember(env, { name: "Bob" });
  token = bob.token;
  await env.DB.prepare(`UPDATE users SET clearance_floor = 7 WHERE id = ?`).bind(bob.member.userId).run();
  await seed("p0", "LEAK-P0 the confidential plan", 0);
  await seed("p7a", "OPEN first plan note", 7);
  await seed("p7b", "OPEN second plan note", 7);
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

describe("RERANKER=jev in /recall", () => {
  it("is off by default: same order, reranked=false, no call to Jev", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = await recall();
    expect(body.reranked).toBe(false);
    expect(body.reranker).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grades only readable candidates, reorders them, and reports reranked + latency", async () => {
    await setConfig({ RERANKER: "jev" });
    const baseline = (await recall()).results.map((r: any) => r.id);
    // Grade the baseline's runner-up as the direct answer.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevReply({ r0: 0, r1: 1 }));
    const body = await recall();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = String((fetchSpy.mock.calls[0][1] as RequestInit).body);
    expect(sent).not.toContain("LEAK-P0");
    expect(sent).toContain("OPEN");
    expect(body.reranked).toBe(true);
    expect(body.reranker).toMatchObject({ mode: "jev", degraded: null });
    expect(typeof body.reranker.ms).toBe("number");
    const ids = body.results.map((r: any) => r.id);
    expect(ids).not.toContain("p0");
    expect(ids[0]).toBe(baseline[1]);
  });

  it("never fails the search: an outage keeps the original order and says so", async () => {
    await setConfig({ RERANKER: "jev" });
    const baseline = (await recall()).results.map((r: any) => r.id);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const res = await worker.fetch(new Request(`${BASE}/recall?query=plan&topK=5`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reranked).toBe(false);
    expect(body.reranker).toMatchObject({ mode: "jev", degraded: "network down" });
    expect(body.results.map((r: any) => r.id)).toEqual(baseline);
  });
});

describe("usage counters", () => {
  const countOf = async (id: string) => (await sqlite.db.prepare(`SELECT access_count AS n, last_accessed_at AS at FROM entries WHERE id = ?`).bind(id).all()).results[0] as { n: number; at: number | null };

  it("counts a memory when it is opened, and only the ones the caller was served", async () => {
    expect(await countOf("p7a")).toEqual({ n: 0, at: null });
    const res = await worker.fetch(new Request(`${BASE}/entry?id=p7a`, { headers: { Authorization: `Bearer ${token}` } }), env, { waitUntil: (p: Promise<unknown>) => void p } as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 20));
    expect((await countOf("p7a")).n).toBe(1);
    expect((await countOf("p7a")).at).toBeGreaterThan(0);
    // An unreadable id is a 404 and is not counted.
    await worker.fetch(new Request(`${BASE}/entry?id=p0`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    await new Promise(r => setTimeout(r, 20));
    expect((await countOf("p0")).n).toBe(0);
  });

  it("counts the memories a recall presents", async () => {
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request(`${BASE}/recall?query=plan&topK=5`, { headers: { Authorization: `Bearer ${token}` } }), env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext);
    const ids = ((await res.json()) as any).results.map((r: any) => r.id);
    await Promise.allSettled(pending);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect((await countOf(id)).n).toBe(1);
    expect((await countOf("p0")).n).toBe(0);
  });
});
