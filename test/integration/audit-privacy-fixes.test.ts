/**
 * Regression tests for the four privacy holes the repo audit found:
 * view-as leaking a private workspace, a planted #session link, members setting
 * their own email, and classified ingest dropping the directory ACL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { commitPlan, type IngestPlan } from "../../src/ingest/pipeline";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";
import type { Env } from "../../src/env";

describe("demo world", () => {
  let w: DemoWorld;
  let ownerToken: string;
  beforeEach(async () => { w = await setupDemoWorld(); ownerToken = (w.env as { AUTH_TOKEN: string }).AUTH_TOKEN; });
  afterEach(() => w.close());

  const viewAs = (path: string) =>
    worker.fetch(new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-View-As": "demo-usr-p8" },
    }), w.env, { waitUntil() {} } as unknown as ExecutionContext);

  it("view-as never shows the person's private workspace", async () => {
    const secret = "segredo-pessoal-do-p8-zzqx";
    const saved = await w.call(DEMO_TOKENS.p8, "POST", "/capture", { content: secret, workspace: "personal" });
    expect(saved.status).toBe(200);

    expect(JSON.stringify(await (await w.call(DEMO_TOKENS.p8, "GET", "/export")).json())).toContain(secret);
    const viewed = await viewAs("/export");
    expect(JSON.stringify(await viewed.json())).not.toContain(secret);
  });

  it("a member cannot set their own email, an admin can set anyone's", async () => {
    const own = await w.call(DEMO_TOKENS.p8, "POST", "/team/profile", { email: "alguem@volanos.ca" });
    expect(own.status).toBe(403);
    expect((await w.call(DEMO_TOKENS.p8, "POST", "/team/profile", { name: "Novo Nome" })).status).toBe(200);
    const byAdmin = await w.call(ownerToken, "POST", "/team/profile", { id: "demo-usr-p8", email: "Alguem@Volanos.ca" });
    expect(byAdmin.status).toBe(200);
    const row = (await w.sqlite.db.prepare("SELECT email FROM users WHERE id = ?").bind("demo-usr-p8").first()) as { email: string } | null;
    expect(row?.email).toBe("alguem@volanos.ca");
  });

  it("classified ingest stamps the directory on published chunks", async () => {
    const plan = {
      docs: [],
      chunks: [{
        docId: "doc-x", id: "chunk-dir-test", classification: null,
        file: { path: "a.md", content: "texto restrito do cliente", source: "bulk-ingest", created_at: Date.now() },
        chunk: { text: "texto restrito do cliente", index: 0, path: "A", nodeId: "n1" },
        node: { id: "n1", parentId: null, title: "A", path: "A", ord: 0 },
        decision: { outcome: "publish", level: 8, review: false, reason: "test" },
      }],
    } as unknown as IngestPlan;
    await commitPlan(w.env, plan, { workspaceId: "", actorId: "demo-usr-p8", directoryId: "demo-dir-dique" }, "demo-usr-p8");
    const row = await w.sqlite.db.prepare("SELECT directory_id FROM entries WHERE id = ?").bind("chunk-dir-test").first() as { directory_id: string } | null;
    expect(row?.directory_id).toBe("demo-dir-dique");
  });
});

describe("Google sign-in nonce", () => {
  let sqlite: SqliteD1;
  let env: Env;
  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" });
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const u = String(input);
      if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ id_token: "idt" }), { status: 200 });
      return new Response(JSON.stringify({ aud: "cid", email: "dono@volanos.ca", email_verified: "true", name: "Dono", exp: String(Math.floor(Date.now() / 1000) + 600) }), { status: 200 });
    }));
  });
  afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

  const run = (path: string) => worker.fetch(new Request(`https://brain.volanos.ca${path}`, { redirect: "manual" }), env, { waitUntil() {} } as unknown as ExecutionContext);

  const invited = async () => {
    const res = await worker.fetch(new Request("https://brain.volanos.ca/team/invites", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ email: "dono@volanos.ca", clearance_floor: 7 }) }), env, { waitUntil() {} } as unknown as ExecutionContext);
    return new URLSearchParams(new URL((await res.json() as { link: string }).link).hash.slice(1)).get("invite")!;
  };

  it("hands the browser's nonce back in the fragment, and ignores a malformed one", async () => {
    const nonce = "abcdefghijklmnopqrstuvwx";
    const start = await worker.fetch(new Request("https://brain.volanos.ca/auth/google/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite: await invited(), n: nonce }) }), env, { waitUntil() {} } as unknown as ExecutionContext);
    const state = new URL((await start.json() as { url: string }).url).searchParams.get("state")!;
    const done = await run(`/auth/google/callback?code=c&state=${state}`);
    const hash = new URLSearchParams(new URL(done.headers.get("Location")!, "https://brain.volanos.ca").hash.slice(1));
    expect(hash.get("n")).toBe(nonce);

    const bad = await run(`/auth/google/start?n=short`);
    const badState = new URL(bad.headers.get("Location")!).searchParams.get("state")!;
    const badDone = await run(`/auth/google/callback?code=c&state=${badState}`);
    expect(badDone.headers.get("Location")).not.toContain("&n=");
  });
});
