/**
 * Permission-leak sweep (docs/volanos/permission-audit.md).
 *
 * Seeds P0, P3, P5, P7 and P9 memories, then asks twenty questions as a P7 member
 * through every read path and proves that no text below P7 shows up anywhere a
 * person — or a model — could see it: response bodies, citations, the prompts that
 * reach the LLM, and the console.
 *
 * The Vectorize double is the hostile case on purpose: it behaves like an index
 * whose metadata filter was rejected, returning EVERY vector (forbidden ones
 * ranked first). Correctness must not depend on the index doing its job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { buildMcpServer } from "../../src/mcp/server";
import { recallEntries } from "../../src/recall/search";
import { captureEntry } from "../../src/capture/entry";
import { compressTag } from "../../src/compression/digest";
import { insightClearance } from "../../src/insight/weekly";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

const BASE = "http://localhost";
const FORBIDDEN = ["LEAK-P0", "LEAK-P3", "LEAK-P5"] as const;
const ALLOWED = ["OPEN-P7", "OPEN-P9"] as const;
const OLD = Date.now() - 400 * 86400000;

let sqlite: SqliteD1;
let env: Env;
let bob: Identity;
let bobToken = "";
let company = "";
let prompts: string[];
let logs: string[];

const waitUntilQueue: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { waitUntilQueue.push(p); } } as unknown as ExecutionContext;

function seed(id: string, content: string, level: number, tags: string[] = ["roadmap"], extra: { dir?: string | null; ws?: string } = {}) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id, recall_count, importance_score)
     VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, 'owner', ?, ?, 0, 0)`,
  ).bind(id, content, JSON.stringify(tags), OLD, OLD, extra.ws ?? company, level, extra.dir ?? null).run();
}

const run = (sql: string, ...args: unknown[]) => sqlite.db.prepare(sql).bind(...args).run();
const rows = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> => ((await sqlite.db.prepare(sql).bind(...args).all()).results as T[]);

const ids = ["p0", "p3", "p5", "p7", "p9"];

function hostileVectorize() {
  const vec = new Array(384).fill(0.1);
  const matches = ids.map((id, i) => ({ id, score: 0.99 - i * 0.01, metadata: { parentId: id }, values: vec }));
  return makeVectorizeMock({
    query: vi.fn().mockResolvedValue({ matches }),
    getByIds: vi.fn().mockResolvedValue(matches.map(m => ({ id: m.id, values: m.values, metadata: m.metadata }))),
  });
}

beforeEach(async () => {
  prompts = [];
  logs = [];
  waitUntilQueue.length = 0;
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(a => String(a)).join(" ")); });
  }
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  const ai = {
    run: vi.fn().mockImplementation(async (model: string, input: unknown) => {
      if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
      prompts.push(JSON.stringify(input));
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"digest text"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: hostileVectorize(), AI: ai });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  company = roots.companyWorkspaceId;
  const member = await createMember(env, { name: "Bob" });
  bobToken = member.token;
  await env.DB.prepare(`UPDATE users SET clearance_floor = 7 WHERE id = ?`).bind(member.member.userId).run();
  bob = {
    userId: member.member.userId, role: "member", personalWorkspaceId: member.member.personalWorkspaceId,
    companyWorkspaceIds: [company], defaultShare: "" as const, clearanceFloor: 7,
  } as Identity;

  seed("p0", "LEAK-P0 acquisition budget roadmap launch", 0, ["roadmap", "ops"]);
  seed("p3", "LEAK-P3 salary budget roadmap launch", 3, ["roadmap", "ops"]);
  seed("p5", "LEAK-P5 vendor budget roadmap launch", 5, ["roadmap", "ops"]);
  seed("p7", "OPEN-P7 team budget roadmap launch", 7, ["roadmap", "ops"]);
  seed("p9", "OPEN-P9 public budget roadmap launch", 9, ["roadmap", "ops"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`${BASE}${path}`, {
  method, headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env, ctx);

async function mcpRecall(query: string): Promise<string> {
  const server = buildMcpServer(env, ctx, bob);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "leak-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return JSON.stringify(await client.callTool({ name: "recall", arguments: { query } }));
  } finally {
    await client.close();
  }
}

const QUESTIONS = [
  "acquisition budget", "salary budget roadmap", "vendor budget launch", "what is the budget", "roadmap launch plan",
  "acquisition secret zero", "salary confidential three", "vendor restricted five", "team budget", "public budget",
  "who earns what", "launch date roadmap", "budget for next quarter", "ops roadmap", "secret acquisition",
  "salary bands", "vendor contracts", "roadmap budget launch acquisition salary vendor", "what did we decide about budget", "OPEN-P7",
];

describe("a P7 account never sees P0, P3 or P5 text on any read path", () => {
  it("asks 20 questions through /recall, /recall?hops, the MCP recall tool and /list", async () => {
    expect(QUESTIONS).toHaveLength(20);
    const seen: string[] = [];
    for (const q of QUESTIONS) {
      const enc = encodeURIComponent(q);
      for (const path of [`/recall?query=${enc}&topK=10`, `/recall?query=${enc}&topK=10&hops=2`, `/recall?query=${enc}&tag=ops&full=1`, `/list?n=100&tag=ops`]) {
        const res = await call("GET", path);
        expect(res.status, path).toBe(200);
        seen.push(await res.text());
      }
      seen.push(await mcpRecall(q));
    }
    await Promise.allSettled(waitUntilQueue);
    const everything = seen.join("\n");
    for (const marker of FORBIDDEN) expect(everything, marker).not.toContain(marker);
    // The sweep is not vacuous: what P7 may read does come back.
    for (const marker of ALLOWED) expect(everything, marker).toContain(marker);
  });

  it("keeps forbidden text out of every prompt that reaches the LLM, and out of the logs", async () => {
    for (const q of QUESTIONS) {
      await call("GET", `/recall?query=${encodeURIComponent(q)}&topK=10`);
      await recallEntries({ query: q, topK: 10, synthesize: true }, env, ctx, undefined, { identity: bob });
    }
    await Promise.allSettled(waitUntilQueue);
    expect(prompts.length).toBeGreaterThan(0);
    for (const marker of FORBIDDEN) {
      expect(prompts.join("\n"), `prompt contains ${marker}`).not.toContain(marker);
      expect(logs.join("\n"), `log contains ${marker}`).not.toContain(marker);
    }
  });

  it("answers by-id reads, counts, exports, tags, graph and stats from the readable set only", async () => {
    for (const id of ["p0", "p3", "p5"]) expect((await call("GET", `/entry?id=${id}`)).status, id).toBe(404);
    for (const id of ["p7", "p9"]) expect((await call("GET", `/entry?id=${id}`)).status, id).toBe(200);
    expect(((await (await call("GET", "/count")).json()) as any).count).toBe(2);

    const bodies: string[] = [];
    for (const path of ["/export", "/tags", "/graph", "/stats", "/stats/graph", "/patterns", "/stale", "/brief", "/connections?id=p0", "/connections?id=p7", "/team/activity"]) {
      const res = await call("GET", path);
      bodies.push(await res.text());
    }
    for (const marker of FORBIDDEN) expect(bodies.join("\n"), marker).not.toContain(marker);
    // A forbidden id must not even be named by the backup's edge table.
    await run(`INSERT INTO edges (source_id, target_id, type, weight, provenance, created_at, updated_at, workspace_id) VALUES ('p0', 'p7', 'related', 1, 'system', ?, ?, ?)`, OLD, OLD, company);
    const exported = await (await call("GET", "/export")).json() as any;
    expect(JSON.stringify(exported.edges)).not.toContain("p0");
  });

  it("does not let /chat probe the level of a memory the caller cannot read", async () => {
    const providerCalls = vi.spyOn(globalThis, "fetch");
    const res = await call("POST", "/chat", { query: "budget", memories: "[1] anything", memory_ids: ["p0"] });
    // p0 is unreadable → the level stays unknown (= restricted); no free provider is ever contacted.
    expect(res.status).toBeLessThan(600);
    expect(providerCalls.mock.calls.some(([u]) => String(u).includes("openrouter"))).toBe(false);
  });

  it("builds digests only from readable rows and stores them at the level of their sources", async () => {
    // 12 P0 and 12 P12 entries on one topic; the cron digests each level on its own.
    // (An index with no neighbours: duplicate detection is covered by its own test.)
    (env.VECTORIZE.query as ReturnType<typeof vi.fn>).mockResolvedValue({ matches: [] });
    for (let i = 0; i < 12; i++) {
      seed(`d0-${i}`, `LEAK-P0 digest source ${i}`, 0, ["quarterly"]);
      seed(`d12-${i}`, `OPEN-P12 digest source ${i}`, 12, ["quarterly"]);
    }
    const res = await call("GET", "/digest?tag=quarterly");
    const body = await res.json() as any;
    // Bob's manual digest saw only the P12 partition.
    expect(body.source_count).toBe(12);
    const written = await rows<{ level: number }>(`SELECT clearance_level AS level FROM entries WHERE tags LIKE '%"synthesized"%'`);
    expect(written.map(r => r.level)).toEqual([12]);
    expect(prompts.join("\n")).not.toContain("LEAK-P0");

    // The unattended nightly digest has no requester: it writes one digest per level.
    await run(`DELETE FROM entries WHERE tags LIKE '%"synthesized"%'`);
    await run(`UPDATE entries SET tags = REPLACE(REPLACE(tags, ',"rolled-up"', ''), '"rolled-up",', '') WHERE 1`);
    await compressTag("quarterly", env, ctx);
    const cron = await rows<{ level: number }>(`SELECT clearance_level AS level FROM entries WHERE tags LIKE '%"synthesized"%' ORDER BY clearance_level`);
    expect(cron.map(r => r.level)).toEqual([0, 12]);
  });

  it("does not let a P7 writer see, name or merge into a P0 neighbour", async () => {
    const result = await captureEntry("acquisition budget roadmap launch", ["roadmap"], "api", env, ctx, undefined, {
      workspaceId: company, actorId: bob.userId, clearanceLevel: 9,
      reader: { userId: bob.userId, admin: false, floor: 7 },
    });
    // Vectorize answered with p0 first at 0.99 ("duplicate"); it is forbidden to this writer.
    expect(result).not.toMatchObject({ status: "blocked", matchId: "p0" });
    expect(JSON.stringify(result)).not.toContain("p0");
    await Promise.allSettled(waitUntilQueue);
    expect(prompts.join("\n")).not.toContain("LEAK-P0");
    expect((await rows<{ content: string }>(`SELECT content FROM entries WHERE id = 'p0'`))[0].content).toBe("LEAK-P0 acquisition budget roadmap launch");
  });

  it("stores an insight at the more restricted level of the two memories it was drawn from", () => {
    expect(insightClearance({ a_clearance: 0, b_clearance: 12 })).toBe(0);
    expect(insightClearance({ a_clearance: 9, b_clearance: 4 })).toBe(4);
    expect(insightClearance({ a_clearance: null, b_clearance: undefined })).toBe(12);
  });

  it("honours a directory ACL per directory, not merely 'any grant exists'", async () => {
    const mk = (id: string) => run(`INSERT INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at) VALUES (?, ?, NULL, ?, ?, 12, 'owner', ?)`, id, company, id, id, OLD);
    await mk("locked"); await mk("granted");
    await run(`INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at) VALUES ('granted', ?, 1, 0, 0, ?)`, bob.userId, OLD);
    await run(`INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at) VALUES ('locked', 'someone-else', 1, 0, 0, ?)`, OLD);
    seed("acl-locked", "LEAK-P3 ACL locked directory note", 12, ["roadmap"], { dir: "locked" });
    seed("acl-granted", "OPEN-P12 ACL granted directory note", 12, ["roadmap"], { dir: "granted" });
    seed("acl-open", "OPEN-P12 no directory note", 12, ["roadmap"]);

    const list = await (await call("GET", "/list?n=100")).json() as any[];
    const text = list.map(r => r.content).join(" ");
    expect(text).toContain("ACL granted directory note");
    expect(text).toContain("no directory note");
    expect(text).not.toContain("ACL locked directory note");
    expect((await call("GET", "/entry?id=acl-locked")).status).toBe(404);
  });
});

describe("permission is applied before the top-K cut, not after", () => {
  it("returns a readable hit for topK=1 even when forbidden vectors outrank it", async () => {
    // The hostile index ranks p0, p3, p5 above p7. Cutting to one slot first and
    // filtering afterwards would leave the caller with nothing.
    const res = await call("GET", "/recall?query=zzqx%20unrelated%20wording&topK=1");
    const body = await res.json() as any;
    expect(body.results).toHaveLength(1);
    expect(["p7", "p9"]).toContain(body.results[0].id);
  });
});

describe("the export and memory-aging surfaces do not widen what a P7 account can read", () => {
  it("shows no suggestion, version or health number that depends on a memory above P7, and keeps admin tools admin-only", async () => {
    // A duplicate pair at P0 and a version of p7 that was P0 when it was written.
    await run(`INSERT INTO aging_suggestions (id, kind, workspace_id, a_id, b_id, score, detail, owner_id, status, created_at) VALUES ('s0', 'contradiction', ?, 'p0', 'p7', 0.9, '{"divergences":[{"aValues":["LEAK-P0 4.2M"],"bValues":["5M"]}]}', 'owner', 'open', ?)`, company, OLD);
    await run(`INSERT INTO aging_suggestions (id, kind, workspace_id, a_id, b_id, score, detail, owner_id, status, created_at) VALUES ('s1', 'duplicate', ?, 'p7', 'p9', 0.97, '{}', '', 'open', ?)`, company, OLD);
    await run(`INSERT INTO entry_versions (id, entry_id, version, content, tags, clearance_level, actor_id, reason, created_at) VALUES ('v-old', 'p7', 1, 'LEAK-P0 older text of p7', '[]', 0, 'x', 'edit', ?)`, OLD);
    await run(`INSERT INTO entry_versions (id, entry_id, version, content, tags, clearance_level, actor_id, reason, created_at) VALUES ('v-ok', 'p7', 2, 'OPEN-P7 older text', '[]', 7, 'x', 'edit', ?)`, OLD);
    await run(`UPDATE entries SET actor_id = ? WHERE id IN ('p7', 'p9')`, bob.userId);

    const suggestions = await (await call("GET", "/memory/suggestions")).text();
    expect(suggestions).toContain("s1");
    expect(suggestions).not.toContain("s0");
    expect(suggestions).not.toContain("LEAK-P0");

    const versions = await (await call("GET", "/entry/versions?id=p7")).text();
    expect(versions).toContain("OPEN-P7 older text");
    expect(versions).not.toContain("LEAK-P0");
    expect((await call("POST", "/entry/restore", { id: "p7", version: 1 })).status).toBe(404);
    expect((await call("GET", "/entry/versions?id=p0")).status).toBe(404);

    // Resolving a pair the caller cannot read answers like a pair that does not exist.
    expect((await call("POST", "/memory/suggestions/resolve", { id: "s0", action: "dismiss" })).status).toBe(404);

    for (const [method, path] of [["GET", "/admin/memory-health"], ["GET", "/admin/export/status"], ["POST", "/admin/export-now"], ["POST", "/admin/rebuild-from-export"], ["POST", "/admin/aging/run"]] as const) {
      expect((await call(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("keeps every level out of a digest built for a P7 account and out of the usage counters it reads", async () => {
    await run(`UPDATE entries SET access_count = 99, last_accessed_at = ? WHERE id = 'p0'`, OLD);
    const body = await (await call("GET", "/brief")).text();
    expect(body).not.toContain("LEAK-P0");
    const stats = await (await call("GET", "/stats")).text();
    expect(stats).not.toContain("LEAK-P0");
  });
});
