import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { loadIntegration } from "../../src/integrations";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
let sqlite: SqliteD1;
let env: Env;
let ownerUserId: string;

function request(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
}

describe("integration OAuth routes", () => {
  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    ownerUserId = (await ensureTenantBootstrap(env)).ownerUserId;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite?.close();
  });

  it("fails clearly when OAuth is not configured, without falling back to a token field", async () => {
    const response = await request("POST", "/integrations/github/oauth/start", {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("COMPOSIO_API_KEY") });
  });

  it("binds the callback account to the server-side state and stores no provider token", async () => {
    env.COMPOSIO_API_KEY = "composio-test-key";
    await env.OAUTH_KV.put("integration-oauth-state:state-1", JSON.stringify({
      provider: "github", userId: ownerUserId, workspace: "company", config: { repo: "gabrielbuarque/volanos-shared-brain", ref: "main" }, createdAt: Date.now(),
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      expect(input).toContain("/connected_accounts/ca-github");
      return new Response(JSON.stringify({ id: "ca-github", user_id: ownerUserId, toolkit: { slug: "github" } }), { status: 200 });
    }));

    const response = await request("GET", "/integrations/oauth/callback?state=state-1&status=success&connected_account_id=ca-github");
    expect(response.status).toBe(302);
    const record = await loadIntegration(env, "github");
    expect(record).toMatchObject({
      authKind: "oauth2",
      credentials: { token: "", connectedAccountId: "ca-github" },
      config: { repo: "gabrielbuarque/volanos-shared-brain", mirrorWorkspace: "company", composioToolkit: "github" },
    });
    expect(JSON.stringify(record)).not.toContain("access_token");
    expect(await env.OAUTH_KV.get("integration-oauth-state:state-1")).toBeNull();
  });
});
