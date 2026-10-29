import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { completeLogin, mintSession } from "../../src/lib/accounts";
import { createMember, rotateMemberToken } from "../../src/lib/team-admin";
import { isAuthorized } from "../../src/lib/http";
import { loginHtml } from "../../src/oauth/pages";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { DEMO_TOKENS, setupDemoWorld } from "../helpers/demo-seed";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});
afterEach(() => sqlite.close());

describe("security hardening", () => {
  it("rotating a token revokes sessions and OAuth grants/tokens of that user only", async () => {
    const { member } = await createMember(env, { name: "Bob" });
    await mintSession(env, member.userId);
    await env.OAUTH_KV.put(`grant:${member.userId}:g1`, "{}");
    await env.OAUTH_KV.put(`token:${member.userId}:g1:t1`, "{}");
    await env.OAUTH_KV.put(`grant:other:g1`, "{}");
    await rotateMemberToken(env, member.userId);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM member_sessions WHERE user_id = ?`).bind(member.userId).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await env.OAUTH_KV.list({ prefix: "grant:" })).keys.map(k => k.name)).toEqual(["grant:other:g1"]);
    expect((await env.OAUTH_KV.list({ prefix: "token:" })).keys).toHaveLength(0);
  });

  it("login page names the requesting app and redirect host, escaped; empty AUTH_TOKEN authorizes nothing", () => {
    const html = loginHtml(undefined, { name: "<b>Evil</b>", redirectHost: "evil.example" });
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).toContain("evil.example");
    const req = new Request("http://x", { headers: { Authorization: "Bearer undefined" } });
    expect(isAuthorized(req, { AUTH_TOKEN: undefined } as unknown as Env)).toBe(false);
    expect(isAuthorized(req, { AUTH_TOKEN: "" } as unknown as Env)).toBe(false);
  });

  it("self-signup is created pending in the same insert", async () => {
    const out = await completeLogin(env, { email: "new@acme.com", name: "New" } as any, null, ["acme.com"]);
    expect(out.kind).toBe("pending");
    const u = await env.DB.prepare(`SELECT suspended, approval_status AS a, clearance_floor AS c FROM users WHERE email = 'new@acme.com'`).first<any>();
    expect(u).toMatchObject({ suspended: 1, a: "pending", c: 12 });
  });
});

describe("propose-edit with direct_publish", () => {
  it("falls back to a proposal when the directory ACL denies write", async () => {
    const w = await setupDemoWorld();
    try {
      const doc = "demo-dique-p12-planilha";
      const row = await w.env.DB.prepare(`SELECT directory_id AS d FROM entries WHERE id = ?`).bind(doc).first<{ d: string }>();
      const me = await w.env.DB.prepare(`SELECT id FROM users WHERE token_hash = ?`).bind(await (await import("../../src/lib/identity")).hashToken(DEMO_TOKENS.p8)).first<{ id: string }>();
      await w.env.DB.prepare(`UPDATE users SET direct_publish = 1 WHERE id = ?`).bind(me!.id).run();
      await w.env.DB.prepare(`INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at) VALUES (?, ?, 1, 0, 0, 0)`).bind(row!.d, me!.id).run();
      const r = await (await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: doc, content: "novo texto do documento" })).json() as any;
      expect(r).toMatchObject({ ok: true, applied: false });
    } finally { w.close(); }
  });
});
