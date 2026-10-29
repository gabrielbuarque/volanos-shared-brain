import type { Env } from "../env";
import { resolveConfig } from "../config";
import { getLevels } from "../ingest/levels";
import {
  approveMember, cancelInvite, changed, completeLogin, createInvite, exchangeGoogleCode, findInviteByHash, findInviteByToken,
  GOOGLE_AUTH_URL, listInvites, parseDomains, resendInvite,
} from "../lib/accounts";
import { adminAuditEvent } from "../lib/admin-audit";
import { json } from "../lib/http";
import { hashToken, requireAdmin, requireIdentity } from "../lib/identity";
import { identityClearanceFloor } from "../lib/permissions";
import { generateToken, TeamAdminError } from "../lib/team-admin";

const STATE_TTL_SECONDS = 600;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><link rel="stylesheet" href="/css/volanos.css"><body class="vol-auth"><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export async function handleAccountRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname;
  const fail = (e: unknown) => {
    if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
    throw e;
  };

  // ── Invites (admin) ───────────────────────────────────────────────────────
  if (path === "/team/invites" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, invites: await listInvites(env) });
  }
  if (path === "/team/invites" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { email?: string; role?: string; clearance_floor?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    try {
      const { invite, token } = await createInvite(env, auth.userId, body);
      adminAuditEvent(env, ctx, { actorId: auth.userId, event: "member_invited", payload: { role: invite.role, clearanceFloor: invite.clearance_floor } });
      // The link is shown once. Delivery by e-mail is the admin's for now.
      return json({ ok: true, invite, link: `${url.origin}/#invite=${token}` }, 201);
    } catch (e) { return fail(e); }
  }
  if (path === "/team/invites/resend" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const out = body.id ? await resendInvite(env, body.id) : null;
    if (!out) return json({ ok: false, error: "Invite not found" }, 404);
    return json({ ok: true, link: `${url.origin}/#invite=${out.token}` });
  }
  if (path === "/team/invites/cancel" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id || !(await cancelInvite(env, body.id))) return json({ ok: false, error: "Invite not found" }, 404);
    adminAuditEvent(env, ctx, { actorId: auth.userId, event: "member_invite_cancelled", payload: { id: body.id } });
    return json({ ok: true });
  }

  // What the invite screen shows before anyone signs in: the level and its text.
  // POST, not GET: an invite secret never goes in a URL (see token-query-param-removed.test.ts).
  if (path === "/invite/info" && request.method === "POST") {
    let body: { token?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const token = typeof body.token === "string" ? body.token : "";
    const invite = token ? await findInviteByToken(env, token) : null;
    if (!invite) return json({ ok: false, error: "Invite not found or expired" }, 404);
    const level = (await getLevels(env))[invite.clearance_floor];
    return json({ ok: true, email: invite.email, role: invite.role, level });
  }

  // ── Pending members and publishing rights (admin) ─────────────────────────
  if (path === "/team/members/approve" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; clearance_floor?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    try {
      if (!body.id || !(await approveMember(env, body.id, body.clearance_floor))) return json({ ok: false, error: "No pending member with that id" }, 404);
    } catch (e) { return fail(e); }
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: body.id, event: "member_approved", payload: { clearanceFloor: body.clearance_floor ?? 12 } });
    return json({ ok: true });
  }
  if (path === "/team/members/direct-publish" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; direct_publish?: boolean };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id || typeof body.direct_publish !== "boolean") return json({ ok: false, error: "id and direct_publish (boolean) are required" }, 400);
    const r = await env.DB.prepare(`UPDATE users SET direct_publish = ? WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`).bind(body.direct_publish ? 1 : 0, body.id).run();
    if (!changed(r)) return json({ ok: false, error: "Member not found" }, 404);
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: body.id, event: "member_direct_publish_set", payload: { directPublish: body.direct_publish } });
    return json({ ok: true });
  }

  // ── Welcome card ──────────────────────────────────────────────────────────
  if (path === "/welcome" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const floor = identityClearanceFloor(auth);
    const levels = await getLevels(env);
    // scope-exempt: reads the caller's own row for a flag; no content
    const flag = await env.DB.prepare(`SELECT direct_publish AS d FROM users WHERE id = ?`).bind(auth.userId).first<{ d: number }>();
    return json({
      ok: true,
      level: levels[floor],
      reads: levels.filter(l => l.level >= floor),
      approval: levels.filter(l => l.level < floor).length > 0,
      direct_publish: flag?.d === 1,
      mcp_url: `${url.origin}/mcp`,
    });
  }

  // ── Google Workspace login ────────────────────────────────────────────────
  // GET starts a plain sign-in. POST {invite} does the same for an invited person
  // and answers with the Google URL, so the invite secret stays out of any URL of ours.
  if (path === "/auth/google/start" && (request.method === "GET" || request.method === "POST")) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return request.method === "POST" ? json({ ok: false, error: "Google login is not configured" }, 503) : page("Login indisponível", "<p>O login com Google ainda não foi configurado por um administrador.</p>", 503);
    const state = (await generateToken()).token;
    let invite: string | null = null;
    // The browser's own random value: it comes back in the sign-in fragment so the page can tell
    // a login THIS tab started from a `#session=` link someone else sent.
    let nonce: string | null = url.searchParams.get("n");
    if (request.method === "POST") {
      try {
        const posted = (await request.json()) as { invite?: string; n?: string };
        invite = posted.invite ?? null;
        nonce = posted.n ?? nonce;
      } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    }
    if (nonce !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) nonce = null;
    await env.OAUTH_KV.put(`login:state:${state}`, JSON.stringify({ inviteHash: invite ? await hashToken(invite) : null, nonce }), { expirationTtl: STATE_TTL_SECONDS });
    const cfg = await resolveConfig(env);
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/google/callback`, response_type: "code",
      scope: "openid email profile", state, prompt: "select_account", access_type: "online",
    });
    const hd = parseDomains(cfg.LOGIN_ALLOWED_DOMAINS)[0];
    if (hd && !invite) params.set("hd", hd);
    const target = `${GOOGLE_AUTH_URL}?${params}`;
    return request.method === "POST" ? json({ ok: true, url: target }) : Response.redirect(target, 302);
  }

  if (path === "/auth/google/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return page("Não foi possível entrar", "<p>Resposta do Google incompleta.</p>", 400);
    const stored = await env.OAUTH_KV.get(`login:state:${state}`);
    if (!stored) return page("Não foi possível entrar", "<p>O pedido de login expirou. Volte e tente de novo.</p>", 400);
    await env.OAUTH_KV.delete(`login:state:${state}`);
    const { inviteHash, nonce } = JSON.parse(stored) as { inviteHash: string | null; nonce?: string | null };
    const profile = await exchangeGoogleCode(env, code, `${url.origin}/auth/google/callback`);
    if (!profile) return page("Não foi possível entrar", "<p>O Google não confirmou a sua conta.</p>", 401);
    const cfg = await resolveConfig(env);
    const invite = inviteHash ? await findInviteByHash(env, inviteHash) : null;
    const outcome = await completeLogin(env, profile, invite, parseDomains(cfg.LOGIN_ALLOWED_DOMAINS));
    if (outcome.kind === "pending") {
      return page("Conta aguardando aprovação", `<p>${escape(profile.email)} foi registrada. Um administrador precisa aprovar o seu acesso e definir o seu nível.</p>`, 202);
    }
    if (outcome.kind === "denied") {
      const why = outcome.reason === "domain" ? "Este e-mail não pertence a um domínio autorizado." : outcome.reason === "invite-email" ? "O convite foi enviado para outro e-mail." : "A sua conta está suspensa.";
      return page("Acesso negado", `<p>${why}</p>`, 403);
    }
    if (outcome.joined) adminAuditEvent(env, ctx, { actorId: outcome.userId, targetUserId: outcome.userId, event: "member_joined", payload: { via: "google" } });
    // The session token travels in the URL fragment, which no server or log sees.
    return new Response(null, { status: 302, headers: { Location: `/#session=${outcome.token}${outcome.joined ? "&welcome=1" : ""}${nonce ? `&n=${nonce}` : ""}`, "Cache-Control": "no-store" } });
  }

  return null;
}
