import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
const BOB = "bob-permission-token";

let sqlite: SqliteD1;
let env: Env;
let bobToken = "";
let bobUserId = "";
let bobWorkspaceId = "";
let companyWorkspaceId = "";

const jsonOf = (response: Response) => response.json() as Promise<any>;

function call(method: string, path: string, token: string, body?: unknown) {
  return worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
}

function seed(id: string, workspaceId: string, actorId: string, content: string, clearance: number, directoryId: string | null = null) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id)
     VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, ?, ?, ?)`,
  ).bind(id, content, Date.now(), Date.now(), workspaceId, actorId, clearance, directoryId).run();
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  bobUserId = bob.member.userId;
  bobWorkspaceId = bob.member.personalWorkspaceId;
  companyWorkspaceId = roots.companyWorkspaceId;
  await env.DB.prepare(`UPDATE users SET clearance_floor = 8 WHERE id = ?`).bind(bobUserId).run();
});

afterEach(() => sqlite.close());

describe("P0-P12 clearance and directory ACL", () => {
  it("filters restricted entries before the member sees list or entry", async () => {
    seed("p4", bobWorkspaceId, bobUserId, "P4 confidential", 4);
    seed("p8", bobWorkspaceId, bobUserId, "P8 operational", 8);
    seed("p12", bobWorkspaceId, bobUserId, "P12 broad", 12);

    const list = await jsonOf(await call("GET", "/list?n=50", bobToken));
    const text = list.map((entry: any) => entry.content).join(" ");
    expect(text).toContain("P8 operational");
    expect(text).toContain("P12 broad");
    expect(text).not.toContain("P4 confidential");
    expect((await call("GET", "/entry?id=p4", bobToken)).status).toBe(404);
  });

  it("honors a directory read ACL even when the clearance level allows it", async () => {
    sqlite.db.prepare(
      `INSERT INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at)
       VALUES ('finance', ?, NULL, 'Finance', 'Finance', 12, ?, ?)`,
    ).bind(companyWorkspaceId, bobUserId, Date.now()).run();
    sqlite.db.prepare(
      `INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at)
       VALUES ('finance', ?, 0, 0, 0, ?)`,
    ).bind(bobUserId, Date.now()).run();
    seed("finance-row", companyWorkspaceId, bobUserId, "Finance restricted", 12, "finance");

    const hidden = await jsonOf(await call("GET", "/list?n=50", bobToken));
    expect(hidden.map((entry: any) => entry.content).join(" ")).not.toContain("Finance restricted");

    await env.DB.prepare(`UPDATE brain_directory_grants SET can_read = 1 WHERE directory_id = 'finance' AND user_id = ?`).bind(bobUserId).run();
    const visible = await jsonOf(await call("GET", "/list?n=50", bobToken));
    expect(visible.map((entry: any) => entry.content).join(" ")).toContain("Finance restricted");
  });

  it("does not let a readable directory grant imply write access", async () => {
    sqlite.db.prepare(
      `INSERT INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at)
       VALUES ('legal', ?, NULL, 'Legal', 'Legal', 12, ?, ?)`,
    ).bind(companyWorkspaceId, bobUserId, Date.now()).run();
    sqlite.db.prepare(
      `INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at)
       VALUES ('legal', ?, 1, 0, 0, ?)`,
    ).bind(bobUserId, Date.now()).run();

    const response = await call("POST", "/capture", bobToken, {
      content: "Attempted legal write",
      workspace: "company",
      directory_id: "legal",
      clearance_level: 12,
    });
    expect(response.status).toBe(403);
    expect((await jsonOf(response)).error).toContain("write to this directory");
  });
});
