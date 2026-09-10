import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSIO_TOOLKITS,
  composioConfigured,
  composioProxy,
  createComposioAuthLink,
  completeComposioAuth,
  hasComposioAccount,
} from "../../src/integrations/composio";
import { makeMemoryKV } from "../helpers/make-env";

function env(key = "composio-test-key") {
  return { OAUTH_KV: makeMemoryKV(), COMPOSIO_API_KEY: key };
}

describe("Composio OAuth boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the four priority providers to OAuth toolkits", () => {
    expect(COMPOSIO_TOOLKITS).toEqual({
      github: "github",
      "google-drive": "googledrive",
      "calendar-google": "googlecalendar",
      "email-gmail": "gmail",
    });
  });

  it("creates a managed auth config once and returns a Connect Link", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      if (input.includes("/auth_configs?")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (input.endsWith("/auth_configs")) return new Response(JSON.stringify({ auth_config: { id: "ac_github" } }), { status: 201 });
      return new Response(JSON.stringify({ redirect_url: "https://connect.composio.dev/link/abc" }), { status: 201 });
    }));

    const result = await createComposioAuthLink(env(), {
      provider: "github", userId: "user-1", callbackUrl: "https://brain.example/integrations/oauth/callback?state=s", alias: "github-test",
    });

    expect(result).toEqual({ redirectUrl: "https://connect.composio.dev/link/abc" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://backend.composio.dev/api/v3.1/auth_configs?toolkit_slug=github&is_composio_managed=true&limit=50",
      "https://backend.composio.dev/api/v3.1/auth_configs",
      "https://backend.composio.dev/api/v3.1/connected_accounts/link",
    ]);
    const linkBody = JSON.parse(String(calls[2].init?.body));
    expect(linkBody).toMatchObject({ auth_config_id: "ac_github", user_id: "user-1", alias: "github-test" });
    expect(linkBody).not.toHaveProperty("token");
  });

  it("completes deferred identity verification and never exposes a provider token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connected_account_id: "ca-1", toolkit_slug: "gmail" }), { status: 200 })));
    await expect(completeComposioAuth(env(), "opaque-session-uri", "user-1")).resolves.toEqual({ connectedAccountId: "ca-1", toolkit: "gmail" });
  });

  it("proxies read-only provider calls through the connected account", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { login: "gabrielbuarque" }, status: 200 }), { status: 200 });
    }));
    await expect(composioProxy(env(), "ca-1", "/user", [{ name: "Accept", value: "application/json", in: "header" }])).resolves.toEqual({ login: "gabrielbuarque" });
    expect(body).toEqual({
      connected_account_id: "ca-1",
      endpoint: "/user",
      method: "GET",
      parameters: [{ name: "Accept", value: "application/json", in: "header" }],
    });
  });

  it("treats an OAuth connected-account id as the credential and does not require a raw token", () => {
    expect(hasComposioAccount({ credentials: { token: "", connectedAccountId: "ca-1" } } as any)).toBe(true);
    expect(composioConfigured({ OAUTH_KV: makeMemoryKV() })).toBe(false);
  });
});
