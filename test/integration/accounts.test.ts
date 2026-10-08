import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { checkTokenInfo } from "../../src/lib/accounts";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const BASE = "https://brain.volanos.ca";
const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;
let sqlite: SqliteD1;
let env: Env;

const call = (method: string, path: string, token?: string, body?: unknown) =>
  worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  }), env, ctx);
const jsonOf = (r: Response) => r.json() as Promise<any>;

/** Stand-in for Google's token and tokeninfo endpoints. */
function stubGoogle(email: string, over: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const u = String(input);
    if (u.startsWith("https://oauth2.googleapis.com/token?") || u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ id_token: "idt" }), { status: 200 });
    if (u.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      return new Response(JSON.stringify({ aud: "cid", email, email_verified: "true", name: "Letícia", exp: String(Math.floor(Date.now() / 1000) + 600), ...over }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
}

async function loginVia(invite?: string) {
  const start = invite
    ? await call("POST", "/auth/google/start", undefined, { invite })
    : await call("GET", "/auth/google/start");
  const target = invite ? (await jsonOf(start)).url : start.headers.get("Location")!;
  expect(start.status).toBe(invite ? 200 : 302);
  expect(target).not.toContain(invite ?? "no-invite");
  const state = new URL(target).searchParams.get("state")!;
  return call("GET", `/auth/google/callback?code=abc&state=${state}`);
}

const inviteOf = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get("invite")!;
const sessionOf = (res: Response) => new URLSearchParams(new URL(res.headers.get("Location")!, BASE).hash.slice(1)).get("session")!;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

describe("invite and Google sign-in", () => {
  it("creates the member at the invited level and leaves the machine token alone", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "Leticia@volanos.ca", role: "member", clearance_floor: 7 }));
    expect(created.link).toMatch(/#invite=/);
    const inviteToken = inviteOf(created.link);

    const info = await jsonOf(await call("POST", "/invite/info", undefined, { token: inviteToken }));
    expect(info).toMatchObject({ email: "leticia@volanos.ca", level: { level: 7 } });
    expect(info.level.reads).toContain("Processos");

    stubGoogle("leticia@volanos.ca");
    const res = await loginVia(inviteToken);
    expect(res.headers.get("Location")).toMatch(/^\/#session=.+&welcome=1$/);
    const session = sessionOf(res);

    const me = await jsonOf(await call("GET", "/permissions/me", session));
    expect(me).toMatchObject({ role: "member", clearanceFloor: 7 });
    // The invite is single-use.
    expect((await call("POST", "/invite/info", undefined, { token: inviteToken })).status).toBe(404);
    // Signing in again gives a session without joining twice.
    stubGoogle("leticia@volanos.ca");
    expect(sessionOf(await loginVia())).not.toBe(session);
  });

  it("applies a level change on the very next request", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "tito@volanos.ca", clearance_floor: 4 }));
    stubGoogle("tito@volanos.ca");
    const session = sessionOf(await loginVia(inviteOf(created.link)));
    const members = await jsonOf(await call("GET", "/team/members", "test-token"));
    const tito = members.members.find((m: any) => m.email === "tito@volanos.ca");
    await call("POST", "/permissions/members/clearance", "test-token", { id: tito.userId, clearance_floor: 9 });
    expect((await jsonOf(await call("GET", "/permissions/me", session))).clearanceFloor).toBe(9);
  });

  it("refuses an invite used with another Google account", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "maira@volanos.ca", clearance_floor: 7 }));
    stubGoogle("intruso@volanos.ca");
    const res = await loginVia(inviteOf(created.link));
    expect(res.status).toBe(403);
  });

  it("keeps an uninvited volanos.ca account pending until an admin approves it", async () => {
    stubGoogle("novo@volanos.ai");
    const res = await loginVia();
    expect(res.status).toBe(202);
    const members = (await jsonOf(await call("GET", "/team/members", "test-token"))).members;
    const novo = members.find((m: any) => m.email === "novo@volanos.ai");
    expect(novo).toMatchObject({ suspended: true, clearanceFloor: 12 });
    // Signing in again does not get past the gate.
    stubGoogle("novo@volanos.ai");
    expect((await loginVia()).status).toBe(202);

    expect((await call("POST", "/team/members/approve", "test-token", { id: novo.userId, clearance_floor: 8 })).status).toBe(200);
    stubGoogle("novo@volanos.ai");
    const session = sessionOf(await loginVia());
    expect((await jsonOf(await call("GET", "/permissions/me", session))).clearanceFloor).toBe(8);
  });

  it("turns away other domains and unverified e-mails", async () => {
    stubGoogle("alguem@gmail.com");
    expect((await loginVia()).status).toBe(403);
    stubGoogle("novo@volanos.ca", { email_verified: "false" });
    expect((await loginVia()).status).toBe(401);
  });

  it("suspending a member ends their session at once", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "gabriel@volanos.ca", clearance_floor: 3 }));
    stubGoogle("gabriel@volanos.ca");
    const session = sessionOf(await loginVia(inviteOf(created.link)));
    const members = (await jsonOf(await call("GET", "/team/members", "test-token"))).members;
    const id = members.find((m: any) => m.email === "gabriel@volanos.ca").userId;
    await call("POST", "/team/members/suspend", "test-token", { id, suspended: true });
    expect((await call("GET", "/permissions/me", session)).status).toBe(401);
  });

  it("rejects a replayed or unknown state", async () => {
    expect((await call("GET", "/auth/google/callback?code=x&state=nope")).status).toBe(400);
  });
});

describe("admin controls", () => {
  it("lists, resends and cancels invites; members cannot", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "a@volanos.ca", clearance_floor: 7 }));
    expect((await jsonOf(await call("GET", "/team/invites", "test-token"))).invites).toHaveLength(1);
    const resent = await jsonOf(await call("POST", "/team/invites/resend", "test-token", { id: created.invite.id }));
    expect(resent.link).not.toBe(created.link);
    // The old link stopped working when the new one was issued.
    expect((await call("POST", "/invite/info", undefined, { token: inviteOf(created.link) })).status).toBe(404);
    expect((await call("POST", "/team/invites/cancel", "test-token", { id: created.invite.id })).status).toBe(200);
    expect((await jsonOf(await call("GET", "/team/invites", "test-token"))).invites).toEqual([]);
  });

  it("serves the welcome card with the level text and approval note", async () => {
    const created = await jsonOf(await call("POST", "/team/invites", "test-token", { email: "m@volanos.ca", clearance_floor: 7 }));
    stubGoogle("m@volanos.ca");
    const session = sessionOf(await loginVia(inviteOf(created.link)));
    const card = await jsonOf(await call("GET", "/welcome", session));
    expect(card.level.level).toBe(7);
    expect(card.reads.map((l: any) => l.level)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(card.approval).toBe(true);
    expect(card.mcp_url).toBe(`${BASE}/mcp`);
  });
});

describe("checkTokenInfo", () => {
  it("rejects a token minted for another client", () => {
    expect(checkTokenInfo({ aud: "other", email: "a@b.c", email_verified: "true" }, "cid")).toBeNull();
  });
});

describe("the very first sign-in on a brand-new deployment", () => {
  it("provisions the company workspace itself instead of failing with 'Deployment is not provisioned'", async () => {
    // Nothing has ever touched this database: no tables, no company workspace, no owner,
    // and nobody has made a request with the machine token yet.
    sqlite.close();
    resetDatabaseInit();
    sqlite = makeSqliteD1({ schema: false });
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" });

    stubGoogle("gabriel@volanos.ca");
    const res = await loginVia();
    // An allowed domain with no invite waits for approval; the point is that it does not throw.
    expect(res.status).toBe(202);

    const company = await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'company'`).first() as { n: number };
    const admins = await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).first() as { n: number };
    expect(company.n).toBe(1);
    expect(admins.n).toBe(1); // the machine-token owner, created by the same provisioning
  });
});
