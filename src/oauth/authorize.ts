import type { Env } from "../env";
import { resolveIdentityFromToken } from "../lib/identity";
import { authorizeErrorHint, authorizeErrorHtml, loginHtml } from "./pages";

export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthReq: any;
  try {
    // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
    // so parseAuthRequest reads the query params cleanly.
    const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
    oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("OAuth authorize parse failed:", detail);
    return new Response(authorizeErrorHtml(authorizeErrorHint(detail), detail), {
      status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") ?? "").trim();
    let grantUserId = "owner";
    let propsUserId = "owner";
    if (!(await isOwnerToken(password, env.AUTH_TOKEN))) {
      const identity = await resolveIdentityFromToken(password, env);
      if (!identity) {
        return new Response(loginHtml("Invalid token", await requesterOf(oauthReq, env)), {
          status: 401, headers: { "Content-Type": "text/html" },
        });
      }
      grantUserId = identity.userId;
      propsUserId = identity.userId;
    }
    const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: grantUserId,
      scope: oauthReq.scope,
      props: { userId: propsUserId },
    });
    return Response.redirect(redirectTo, 302);
  }
  return new Response(loginHtml(undefined, await requesterOf(oauthReq, env)), { headers: { "Content-Type": "text/html" } });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Compares fixed-length digests without early exit; an unset AUTH_TOKEN matches nothing.
async function isOwnerToken(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function requesterOf(oauthReq: any, env: Env): Promise<{ name: string; redirectHost: string }> {
  const client = await (env as any).OAUTH_PROVIDER.lookupClient(oauthReq.clientId).catch(() => null);
  let redirectHost = "unknown";
  try { redirectHost = new URL(oauthReq.redirectUri).host; } catch { /* keep unknown */ }
  return { name: client?.clientName || "An unnamed app", redirectHost };
}
