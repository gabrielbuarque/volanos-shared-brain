import type { IntegrationEnv, IntegrationRecord } from "./framework";

/**
 * Composio is deliberately an authentication and API-proxy boundary here.
 * The Shared Brain still owns mirroring, provenance and P0–P12 filtering.
 */
const API = "https://backend.composio.dev/api/v3.1";
const AUTH_CONFIG_PREFIX = "composio:auth-config:";

export const COMPOSIO_TOOLKITS: Record<string, string> = {
  github: "github",
  "google-drive": "googledrive",
  "calendar-google": "googlecalendar",
  "email-gmail": "gmail",
};

export function composioToolkitForProvider(provider: string): string | null {
  return COMPOSIO_TOOLKITS[provider] ?? null;
}

export function isComposioOAuthProvider(provider: string): boolean {
  return composioToolkitForProvider(provider) !== null;
}

export function hasComposioAccount(record: IntegrationRecord | null): record is IntegrationRecord & {
  credentials: { token: string; connectedAccountId: string };
} {
  return typeof record?.credentials?.connectedAccountId === "string" && record.credentials.connectedAccountId.length > 0;
}

export function composioConfigured(env: IntegrationEnv): boolean {
  return typeof env.COMPOSIO_API_KEY === "string" && env.COMPOSIO_API_KEY.trim().length > 0;
}

function requireApiKey(env: IntegrationEnv): string {
  const key = env.COMPOSIO_API_KEY?.trim();
  if (!key) throw new Error("OAuth integrations are not configured: set COMPOSIO_API_KEY on the Worker.");
  return key;
}

function errorMessage(body: any, status: number): string {
  const detail = body?.message ?? body?.error?.message ?? body?.error ?? body?.detail;
  return typeof detail === "string" && detail.trim() ? detail : `Composio API error (${status})`;
}

async function composioApi(env: IntegrationEnv, path: string, init: RequestInit = {}): Promise<any> {
  const key = requireApiKey(env);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

/** Return an existing managed OAuth config, creating one on first use. */
async function ensureAuthConfig(env: IntegrationEnv, toolkit: string): Promise<string> {
  const key = `${AUTH_CONFIG_PREFIX}${toolkit}`;
  const cached = await env.OAUTH_KV.get(key);
  if (cached) return cached;

  const listed = await composioApi(env, `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=50`);
  const existing = (listed?.items ?? []).find((item: any) =>
    item?.is_composio_managed === true && item?.auth_scheme === "OAUTH2" && item?.status !== "DISABLED" && typeof item?.id === "string",
  );
  const id = existing?.id ?? (await composioApi(env, "/auth_configs", {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: toolkit },
      auth_config: { type: "use_composio_managed_auth", credentials: {}, restrict_to_following_tools: [] },
    }),
  }))?.auth_config?.id;
  if (typeof id !== "string" || !id) throw new Error(`Composio did not return an OAuth config for ${toolkit}.`);
  await env.OAUTH_KV.put(key, id);
  return id;
}

export async function createComposioAuthLink(
  env: IntegrationEnv,
  params: { provider: string; userId: string; callbackUrl: string; alias: string },
): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
  const toolkit = composioToolkitForProvider(params.provider);
  if (!toolkit) throw new Error(`OAuth is not available for ${params.provider}.`);
  const authConfigId = await ensureAuthConfig(env, toolkit);
  const body = await composioApi(env, "/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: params.userId,
      callback_url: params.callbackUrl,
      alias: params.alias,
    }),
  });
  if (typeof body?.redirect_url !== "string" || !body.redirect_url) {
    throw new Error("Composio did not return an OAuth redirect URL.");
  }
  return { redirectUrl: body.redirect_url, connectedAccountId: body.connected_account_id };
}

export async function completeComposioAuth(
  env: IntegrationEnv,
  sessionUri: string,
  userId: string,
): Promise<{ connectedAccountId: string; toolkit: string }> {
  const body = await composioApi(env, "/connected_accounts/complete_auth", {
    method: "POST",
    body: JSON.stringify({ session_uri: sessionUri, user_id: userId }),
  });
  if (typeof body?.connected_account_id !== "string" || typeof body?.toolkit_slug !== "string") {
    throw new Error("Composio did not activate the OAuth connection.");
  }
  return { connectedAccountId: body.connected_account_id, toolkit: body.toolkit_slug };
}

export async function getComposioConnectedAccount(env: IntegrationEnv, accountId: string): Promise<any> {
  return composioApi(env, `/connected_accounts/${encodeURIComponent(accountId)}`);
}

export async function revokeComposioConnectedAccount(env: IntegrationEnv, accountId: string): Promise<void> {
  await composioApi(env, `/connected_accounts/${encodeURIComponent(accountId)}/revoke`, { method: "POST" });
}

/** Proxy an authenticated, read-only provider request without exposing OAuth tokens. */
export async function composioProxy(
  env: IntegrationEnv,
  accountId: string,
  endpoint: string,
  parameters: Array<{ name: string; value: string; in: "query" | "header" }> = [],
): Promise<any> {
  const body = await composioApi(env, "/tools/execute/proxy", {
    method: "POST",
    body: JSON.stringify({ connected_account_id: accountId, endpoint, method: "GET", parameters }),
  });
  return body?.data ?? body;
}
