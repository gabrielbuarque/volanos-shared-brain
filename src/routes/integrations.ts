import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  saveIntegration,
  deleteIntegration,
  integrationStatus,
} from "../integrations";
import type { IntegrationRecord } from "../integrations";
import type { Env } from "../env";
import { json } from "../lib/http";
import { adminAuditEvent } from "../lib/admin-audit";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { listRoster } from "../lib/team-admin";
import { forgetEntry } from "../capture/lifecycle";
import { getReadableEntry, assertCanMutateEntry } from "../lib/entry-access";
import { makeMirrorStore, mirrorWriteContext } from "../integrations/mirror";
import {
  composioConfigured,
  composioToolkitForProvider,
  completeComposioAuth,
  createComposioAuthLink,
  getComposioConnectedAccount,
  isComposioOAuthProvider,
  revokeComposioConnectedAccount,
} from "../integrations/composio";

const OAUTH_STATE_PREFIX = "integration-oauth-state:";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

interface OAuthState {
  provider: string;
  userId: string;
  workspace: "personal" | "company";
  config: Record<string, unknown>;
  createdAt: number;
}

function oauthStateKey(state: string): string { return `${OAUTH_STATE_PREFIX}${state}`; }

function oauthRedirect(url: URL, provider: string | null, status: "success" | "error", message?: string): Response {
  const target = new URL("/", url.origin);
  if (provider) target.searchParams.set("integration", provider);
  target.searchParams.set("oauth", status);
  if (message) target.searchParams.set("message", message.slice(0, 240));
  return Response.redirect(target.toString(), 302);
}

export async function handleIntegrationsRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /integrations — provider list + connection status (never the token)
  if (url.pathname === "/integrations" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const integrations = [];
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      integrations.push(integrationStatus(provider, await loadIntegration(env, provider.id)));
    }
    // Who connected it, as a NAME. Resolved through listRoster, not
    // lookupActorLabels: the id comes out of a KV blob rather than from an
    // already-scoped read, and the roster is the only people-list in this
    // codebase that is scoped to the caller's own teams. A connector who is not
    // the caller's teammate resolves to null and the client omits the line,
    // which is also what a solo brain gets, and what a brain whose connecting
    // admin has since been removed gets.
    //
    // Resolved at read time rather than snapshotted at connect time so a rename
    // propagates and a departure degrades to null instead of to a stale name —
    // the same rule lookupActorLabels's soft-delete filter enforces elsewhere.
    const ids = integrations.map((i) => i.connectedByUserId).filter(Boolean) as string[];
    const roster = ids.length ? await listRoster(env, auth.companyWorkspaceIds) : [];
    const nameOf = new Map(roster.map((r) => [r.userId, r.name]));
    // Read is open to every member; the write actions below are not. The flag
    // lets the dashboard render a member the connection state without also
    // rendering Connect and Disconnect buttons that can only answer 403.
    return json({
      ok: true,
      // connectedByUserId is destructured OUT: the response carries a name or
      // null and never an id, because a member has no use for a colleague's
      // user id and the roster's allowlist argument applies to every
      // people-shaped field this codebase publishes.
      integrations: integrations.map(({ connectedByUserId, ...rest }) => ({
        ...rest,
        connectedBy: connectedByUserId ? nameOf.get(connectedByUserId) ?? null : null,
        oauthProvider: isComposioOAuthProvider(rest.provider),
        oauthConfigured: isComposioOAuthProvider(rest.provider) && composioConfigured(env),
      })),
      admin: auth.role === "admin",
    });
  }

  // POST /integrations/:provider/oauth/start — create a short-lived Composio
  // Connect Link. The state is kept server-side so the callback does not trust
  // user-controlled query parameters for the workspace or clearance policy.
  const oauthStart = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/oauth\/start$/);
  if (oauthStart && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const provider = getProvider(oauthStart[1]);
    if (!provider || !isComposioOAuthProvider(provider.id)) {
      return json({ ok: false, error: `OAuth is not available for ${oauthStart[1]}` }, 404);
    }
    if (!composioConfigured(env)) {
      return json({ ok: false, error: "OAuth is not configured. Set the COMPOSIO_API_KEY Worker secret first." }, 503);
    }
    let body: { workspace?: string; config?: Record<string, unknown> } = {};
    try { body = await request.json(); } catch { /* optional body */ }
    const state = crypto.randomUUID();
    const stateRecord: OAuthState = {
      provider: provider.id,
      userId: auth.userId,
      workspace: body.workspace === "company" ? "company" : "personal",
      config: body.config ?? {},
      createdAt: Date.now(),
    };
    await env.OAUTH_KV.put(oauthStateKey(state), JSON.stringify(stateRecord), { expirationTtl: OAUTH_STATE_TTL_SECONDS });
    const callbackUrl = new URL(env.COMPOSIO_CALLBACK_URL?.trim() || "/integrations/oauth/callback", url.origin);
    callbackUrl.searchParams.set("state", state);
    try {
      const link = await createComposioAuthLink(env, {
        provider: provider.id,
        userId: auth.userId,
        callbackUrl: callbackUrl.toString(),
        alias: `${provider.id}-${state.slice(0, 8)}`,
      });
      return json({ ok: true, redirectUrl: link.redirectUrl });
    } catch (e) {
      await env.OAUTH_KV.delete(oauthStateKey(state));
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // GET /integrations/oauth/callback — finish the browser redirect. In the
  // normal flow Composio returns connected_account_id. When callback identity
  // verification is enabled, it returns a single-use session_uri instead and
  // we redeem it with the user id bound to the server-side state.
  if (url.pathname === "/integrations/oauth/callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    if (!state) return oauthRedirect(url, null, "error", "OAuth state is missing");
    const rawState = await env.OAUTH_KV.get(oauthStateKey(state));
    await env.OAUTH_KV.delete(oauthStateKey(state));
    if (!rawState) return oauthRedirect(url, null, "error", "OAuth session expired");
    let stateRecord: OAuthState;
    try { stateRecord = JSON.parse(rawState) as OAuthState; } catch { return oauthRedirect(url, null, "error", "OAuth state is invalid"); }
    const provider = getProvider(stateRecord.provider);
    const toolkit = composioToolkitForProvider(stateRecord.provider);
    if (!provider || !toolkit || !composioConfigured(env)) return oauthRedirect(url, stateRecord.provider, "error", "OAuth is not configured");
    if (url.searchParams.get("status") === "failed") return oauthRedirect(url, provider.id, "error", "The provider denied access");

    try {
      let accountId = url.searchParams.get("connected_account_id") || url.searchParams.get("connectedAccountId");
      const sessionUri = url.searchParams.get("session_uri");
      if (sessionUri) {
        const completed = await completeComposioAuth(env, sessionUri, stateRecord.userId);
        if (completed.toolkit !== toolkit) throw new Error("OAuth toolkit mismatch");
        accountId = completed.connectedAccountId;
      }
      if (!accountId) throw new Error("OAuth provider returned no connected account");
      const account = await getComposioConnectedAccount(env, accountId);
      const accountUserId = account?.user_id ?? account?.userId;
      const accountToolkit = account?.toolkit?.slug ?? account?.toolkit_slug;
      if (accountUserId && accountUserId !== stateRecord.userId) throw new Error("OAuth account owner mismatch");
      if (accountToolkit && accountToolkit !== toolkit) throw new Error("OAuth toolkit mismatch");

      const existing = await loadIntegration(env, provider.id);
      const now = Date.now();
      const record: IntegrationRecord = {
        provider: provider.id,
        authKind: "oauth2",
        credentials: { token: "", connectedAccountId: accountId },
        config: {
          ...(existing?.config ?? {}),
          ...stateRecord.config,
          mirrorWorkspace: stateRecord.workspace,
          connectedByUserId: stateRecord.userId,
          composioToolkit: toolkit,
        },
        status: "connected",
        workspaceName: `${provider.name} OAuth`,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      adminAuditEvent(env, ctx, {
        actorId: stateRecord.userId,
        event: "integration_connected",
        payload: { provider: provider.id, mirrorWorkspace: stateRecord.workspace, authKind: "oauth2", toolkit },
      });
      return oauthRedirect(url, provider.id, "success");
    } catch (e) {
      return oauthRedirect(url, provider.id, "error", e instanceof Error ? e.message : String(e));
    }
  }

  // POST /integrations/:provider/(connect|sync|disconnect)
  //
  // Admin-only, because an integration is one connection for the whole
  // deployment: `integrations:<provider>` is a single KV blob, so "connect" is
  // not a member adding their own Notion but a member REPLACING the org's, token
  // and all, with nothing in the response to either party saying so. Disconnect
  // removed it for everyone. Read stays open below — a member can see what is
  // connected and when it last synced, just not change it.
  //
  // If per-member connections land later, this gate is what comes off, together
  // with the storage key. test/integration/integrations-tenancy.test.ts pins the
  // current contract either way.
  const integrationRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/(connect|sync|disconnect)$/);
  if (integrationRoute && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const provider = getProvider(integrationRoute[1]);
    if (!provider) return json({ ok: false, error: `Unknown integration: ${integrationRoute[1]}` }, 404);
    const action = integrationRoute[2];

    // connect — validate the pasted token against the provider's API
    // (server-side; the browser can't for CORS reasons) and store it only if
    // it works.
    if (action === "connect") {
      let body: { token?: string; workspace?: string; config?: Record<string, unknown> };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const token = body.token?.trim();
      if (!token) return json({ ok: false, error: "token is required" }, 400);
      const mirrorWorkspace = body.workspace === "company" ? "company" : "personal";

      let workspaceName: string;
      try {
        workspaceName = await provider.validateToken(token);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }

      // Preserve the item map across reconnects so already-mirrored items
      // update in place instead of duplicating.
      const existing = await loadIntegration(env, provider.id);
      const now = Date.now();
      const record: IntegrationRecord = {
        provider: provider.id,
        authKind: provider.authKind ?? "token",
        credentials: { token },
        // connectedByUserId is written on EVERY connect, reconnects included:
        // the person who last handed the deployment a token is the person to
        // ask about it, so it names the current connector rather than the
        // original one. It lives in `config` beside mirrorWorkspace — the
        // documented escape hatch, carried across reconnects by the spread, and
        // one place to look for connection policy.
        config: { ...(existing?.config ?? {}), ...(body.config ?? {}), mirrorWorkspace, connectedByUserId: auth.userId },
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      // The trail, not the blob. `connectedByUserId` above answers "who
      // connected the thing that is connected NOW" and is overwritten by the
      // next reconnect; it cannot answer "who connected it in March and who
      // disconnected it in April". `mirrorWorkspace` is in the payload because
      // where a connector's content lands is the visibility decision the
      // connect makes. The token is not, and nothing that is or contains a
      // credential ever will be — the rule member_token_rotated set.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        event: "integration_connected",
        // provider.id, not `provider`: the local is the registry OBJECT here,
        // and JSON.stringify of it would put the provider's display name and
        // category in the trail instead of the id an auditor filters on.
        payload: { provider: provider.id, mirrorWorkspace },
      });
      return json({ ok: true, provider: provider.id, workspaceName, mirrorWorkspace });
    }

    // sync — one bounded batch; callers loop while `remaining` > 0 (same
    // pattern as POST /vectorize-pending).
    if (action === "sync") {
      const record = await loadIntegration(env, provider.id);
      if (!record) {
        return json({ ok: false, error: `${provider.name} is not connected` }, 404);
      }
      // The same context the nightly cron uses. Built from the caller before,
      // which meant one connection mirrored into different workspaces depending
      // on who pressed "Sync now" — so a page synced by hand and the same page
      // synced overnight landed in two different people's private space.
      const result = await provider.sync(
        env,
        makeMirrorStore(env, await mirrorWriteContext(env, record)),
      );
      return json(result, result.ok ? 200 : 502);
    }

    // disconnect — remove the connection. Mirrored memories are kept
    // (they're the user's data) unless purge=true.
    let body: { purge?: boolean } = {};
    try { body = await request.json(); } catch { /* empty body — keep memories */ }
    const record = await loadIntegration(env, provider.id);
    if (!record) return json({ ok: false, error: `${provider.name} is not connected` }, 404);

    let purged = 0;
    let skipped = 0;
    if (body.purge) {
      for (const mapped of Object.values(record.itemMap)) {
        try {
          // Same guard /forget applies, for the same reason. `forgetEntry` deletes
          // by id with no workspace clause, and the integration record is one
          // deployment-wide blob every member can reach, so an unguarded purge let
          // any member delete mirrored rows out of a colleague's private workspace —
          // rows they could not read through /entry, edit through /update, or delete
          // through /forget. A purge now removes only what this caller could have
          // deleted one at a time; anything else is left standing and counted.
          const row = await getReadableEntry(env, auth, mapped.entryId);
          if (!row || assertCanMutateEntry(auth, row)) { skipped++; continue; }
          const r = await forgetEntry(mapped.entryId, env);
          if (r.status === "deleted") purged++;
        } catch (e) {
          console.error("Mirror purge failed (non-fatal):", e);
        }
      }
    }
    if (record.credentials.connectedAccountId && composioConfigured(env)) {
      try {
        await revokeComposioConnectedAccount(env, record.credentials.connectedAccountId);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    await deleteIntegration(env, provider.id);
    // A separate name rather than integration_connected with a boolean, for the
    // reason member_suspended/member_unsuspended already gives: an auditor
    // scanning for "when did this stop mirroring" should not have to read a
    // payload to find out.
    adminAuditEvent(env, ctx, {
      actorId: auth.userId,
      event: "integration_disconnected",
      payload: { provider: provider.id },
    });
    // `kept` counts what is deliberately left behind: everything, when no purge was
    // asked for, plus anything a purge was not allowed to touch.
    return json({
      ok: true,
      purged,
      kept: body.purge ? skipped : Object.keys(record.itemMap).length,
    });
  }

  return null;
}
