/**
 * Loads scripts/seed-demo-volanos.mjs into the real-SQLite D1 double, the same
 * SQL a person would run with `--apply`. The Vectorize double is hostile on
 * purpose: it returns EVERY seeded entry, forbidden ones first, so correctness
 * rests on the SQL filter and never on the index.
 */
import { vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "./make-env";
import { makeSqliteD1, type SqliteD1 } from "./sqlite-d1";
import type { Env } from "../../src/env";
import { buildDemoSeed, demoSeedSql, DEMO_USERS } from "../../scripts/seed-demo-volanos.mjs";

export const DEMO_TOKENS: Record<"p0" | "p6" | "p8", string> = {
  p0: DEMO_USERS[0].token,
  p6: DEMO_USERS[1].token,
  p8: DEMO_USERS[2].token,
};

export interface DemoWorld {
  sqlite: SqliteD1;
  env: Env;
  prompts: string[];
  call: (token: string, method: string, path: string, body?: unknown) => Promise<Response>;
  close: () => void;
}

export async function setupDemoWorld(): Promise<DemoWorld> {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const prompts: string[] = [];
  const ai = {
    run: vi.fn().mockImplementation(async (model: string, input: unknown) => {
      if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
      prompts.push(JSON.stringify(input));
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"ok"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
  const seed = buildDemoSeed();
  const vec = new Array(384).fill(0.1);
  const matches = seed.entries.map((e: { id: string }, i: number) => ({ id: e.id, score: 0.99 - i * 0.001, metadata: { parentId: e.id }, values: vec }));
  const vectorize = makeVectorizeMock({
    query: vi.fn().mockResolvedValue({ matches }),
    getByIds: vi.fn().mockResolvedValue(matches.map((m: { id: string; values: number[]; metadata: unknown }) => ({ id: m.id, values: m.values, metadata: m.metadata }))),
  });
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vectorize, AI: ai });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  sqlite.db.exec(demoSeedSql());
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  return {
    sqlite, env, prompts,
    call: (token, method, path, body) => worker.fetch(new Request(`http://localhost${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx),
    close: () => sqlite.close(),
  };
}
