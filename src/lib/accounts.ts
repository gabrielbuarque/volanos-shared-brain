import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { ensureTenantBootstrap } from "./tenancy";
import { hashToken } from "./identity";
import { createMember, generateToken, TeamAdminError } from "./team-admin";
import { normalizeClearance } from "./permissions";

/**
 * Invites, Google Workspace login and per-person sessions.
 *
 * The machine bearer token (MCP, scripts) stays exactly as it was. A person who
 * signs in with Google gets a *session* token of their own, so signing in on a
 * laptop never rotates the token an MCP client is using.
 */

export const INVITE_TTL_MS = 14 * 86_400_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** D1 reports `changes`; the SQLite test double reports `rows_written`. */
export function changed(r: { meta?: Record<string, unknown> }): boolean {
  return Number(r.meta?.changes ?? r.meta?.rows_written ?? 0) > 0;
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@").at(-1) ?? "";
}

export function parseDomains(csv: string): string[] {
  return csv.split(",").map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

export function domainAllowed(email: string, allowed: readonly string[]): boolean {
  return allowed.includes(domainOf(email));
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function mintSession(env: Env, userId: string): Promise<string> {
  const { token, tokenHash } = await generateToken();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO member_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, userId, now, now + SESSION_TTL_MS).run();
  return token;
}

// ── Invites ─────────────────────────────────────────────────────────────────

export interface InviteRow {
  id: string;
  email: string;
  role: "admin" | "member";
  clearance_floor: number;
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  cancelled_at: number | null;
}

export async function createInvite(
  env: Env,
  actorId: string,
  input: { email?: string; role?: string; clearance_floor?: unknown },
): Promise<{ invite: InviteRow; token: string }> {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TeamAdminError(400, "That does not look like an email address");
  const level = normalizeClearance(input.clearance_floor);
  if (level === null) throw new TeamAdminError(400, "clearance_floor must be an integer from 0 to 12");
  if (input.role !== undefined && input.role !== "admin" && input.role !== "member") throw new TeamAdminError(400, 'role must be "admin" or "member"');
  const role = input.role === "admin" ? "admin" : "member";
  // scope-exempt: membership lookup by email, no content
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ? AND (removed_at IS NULL OR removed_at = 0)`).bind(email).first();
  if (existing) throw new TeamAdminError(409, "A member with that email already exists");
  const { token, tokenHash } = await generateToken();
  const now = Date.now();
  const id = `inv-${crypto.randomUUID()}`;
  // Re-inviting the same address replaces the earlier pending invite.
  await env.DB.batch([
    env.DB.prepare(`UPDATE member_invites SET cancelled_at = ? WHERE email = ? AND accepted_at IS NULL AND cancelled_at IS NULL`).bind(now, email),
    env.DB.prepare(`INSERT INTO member_invites (id, email, role, clearance_floor, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, email, role, level, tokenHash, actorId, now, now + INVITE_TTL_MS),
  ]);
  return { invite: { id, email, role, clearance_floor: level, invited_by: actorId, created_at: now, expires_at: now + INVITE_TTL_MS, accepted_at: null, cancelled_at: null }, token };
}

export async function listInvites(env: Env): Promise<InviteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, email, role, clearance_floor, invited_by, created_at, expires_at, accepted_at, cancelled_at
     FROM member_invites WHERE accepted_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  ).all<InviteRow>();
  return results ?? [];
}

export async function cancelInvite(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE member_invites SET cancelled_at = ? WHERE id = ? AND accepted_at IS NULL AND cancelled_at IS NULL`).bind(Date.now(), id).run();
  return changed(r);
}

/** Replace the secret of a pending invite and extend it. */
export async function resendInvite(env: Env, id: string): Promise<{ token: string; email: string } | null> {
  const row = await env.DB.prepare(`SELECT email FROM member_invites WHERE id = ? AND accepted_at IS NULL AND cancelled_at IS NULL`).bind(id).first<{ email: string }>();
  if (!row) return null;
  const { token, tokenHash } = await generateToken();
  await env.DB.prepare(`UPDATE member_invites SET token_hash = ?, expires_at = ? WHERE id = ?`).bind(tokenHash, Date.now() + INVITE_TTL_MS, id).run();
  return { token, email: row.email };
}

export async function findInviteByToken(env: Env, token: string): Promise<InviteRow | null> {
  return findInviteByHash(env, await hashToken(token));
}

export async function findInviteByHash(env: Env, tokenHash: string): Promise<InviteRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, role, clearance_floor, invited_by, created_at, expires_at, accepted_at, cancelled_at FROM member_invites WHERE token_hash = ?`,
  ).bind(tokenHash).first<InviteRow>();
  if (!row || row.accepted_at || row.cancelled_at || row.expires_at < Date.now()) return null;
  return row;
}

// ── Google login ────────────────────────────────────────────────────────────

export interface GoogleProfile { email: string; name: string; hd?: string }

/** Pure check of a tokeninfo payload: right audience, verified email, allowed domain. */
export function checkTokenInfo(info: any, clientId: string): GoogleProfile | null {
  if (!info || info.aud !== clientId) return null;
  if (info.email_verified !== true && info.email_verified !== "true") return null;
  if (typeof info.email !== "string") return null;
  if (typeof info.exp !== "undefined" && Number(info.exp) * 1000 < Date.now()) return null;
  return { email: info.email.toLowerCase(), name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : info.email.split("@")[0], hd: info.hd };
}

export async function exchangeGoogleCode(env: Env, code: string, redirectUri: string): Promise<GoogleProfile | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) return null;
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) return null;
  // Google's own endpoint verifies the signature and expiry for us.
  const info = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(id_token)}`);
  if (!info.ok) return null;
  return checkTokenInfo(await info.json(), env.GOOGLE_CLIENT_ID);
}

export type LoginOutcome =
  | { kind: "session"; token: string; userId: string; joined: boolean }
  | { kind: "pending" }
  | { kind: "denied"; reason: "domain" | "invite-email" | "suspended" };

/**
 * Decide what a verified Google identity gets.
 *  1. A valid invite for that exact address creates the member at the invited level.
 *  2. An existing member signs in.
 *  3. An allowed domain without an invite waits as "pending" at P12 until an admin approves.
 *  4. Anyone else is turned away.
 */
export async function completeLogin(
  env: Env,
  profile: GoogleProfile,
  invite: InviteRow | null,
  allowedDomains: readonly string[],
): Promise<LoginOutcome> {
  // A brand-new deployment has no company workspace and no owner until something
  // provisions them, and that used to happen only on the first request carrying the
  // machine token. The first person through the door is often someone signing in
  // with Google, and createMember threw "Deployment is not provisioned". Provision
  // here too: idempotent, memoised, and it only ever uses AUTH_TOKEN.
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  // scope-exempt: identity lookup by verified email, no content
  const existing = await env.DB.prepare(
    `SELECT id, suspended, approval_status AS approval FROM users WHERE email = ? AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(profile.email).first<{ id: string; suspended: number; approval: string }>();

  if (existing) {
    if (existing.approval === "pending") return { kind: "pending" };
    if (existing.suspended) return { kind: "denied", reason: "suspended" };
    return { kind: "session", token: await mintSession(env, existing.id), userId: existing.id, joined: false };
  }

  if (invite) {
    if (invite.email !== profile.email) return { kind: "denied", reason: "invite-email" };
    const { member } = await createMember(env, { name: profile.name, email: profile.email, role: invite.role });
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET clearance_floor = ? WHERE id = ?`).bind(invite.clearance_floor, member.userId),
      env.DB.prepare(`UPDATE member_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL`).bind(Date.now(), invite.id),
    ]);
    return { kind: "session", token: await mintSession(env, member.userId), userId: member.userId, joined: true };
  }

  if (!domainAllowed(profile.email, allowedDomains)) return { kind: "denied", reason: "domain" };
  const { member } = await createMember(env, { name: profile.name, email: profile.email, role: "member" });
  await env.DB.prepare(`UPDATE users SET clearance_floor = 12, suspended = 1, approval_status = 'pending' WHERE id = ?`).bind(member.userId).run();
  return { kind: "pending" };
}

/** Admin approves a pending self-signup, optionally choosing the level. */
export async function approveMember(env: Env, userId: string, level: unknown): Promise<boolean> {
  const floor = normalizeClearance(level, 12);
  if (floor === null) throw new TeamAdminError(400, "clearance_floor must be an integer from 0 to 12");
  const r = await env.DB.prepare(
    `UPDATE users SET suspended = 0, approval_status = 'active', clearance_floor = ? WHERE id = ? AND approval_status = 'pending' AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(floor, userId).run();
  return changed(r);
}

/** Offboarding closes every session at once. */
export async function revokeSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM member_sessions WHERE user_id = ?`).bind(userId).run();
}
