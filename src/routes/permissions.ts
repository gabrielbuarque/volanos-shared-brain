import type { Env } from "../env";
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { readScopeWorkspaces, scopeWrite } from "../lib/scope";
import { CLEARANCE_MAX, CLEARANCE_MIN, normalizeClearance } from "../lib/permissions";
import { adminAuditEvent } from "../lib/admin-audit";

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return path.slice(0, 500);
}

export async function handlePermissionRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/permissions/me" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // scope-exempt: reads the caller's own users row for a display name; no content
    const row = await env.DB.prepare(`SELECT name, email FROM users WHERE id = ?`).bind(auth.userId).first<{ name: string; email: string | null }>();
    return json({ ok: true, userId: auth.userId, name: row?.name ?? "", email: row?.email ?? null, role: auth.role, clearanceFloor: auth.role === "admin" ? 0 : auth.clearanceFloor ?? 12, levels: { min: CLEARANCE_MIN, max: CLEARANCE_MAX }, viewAs: !!auth.viewAsBy });
  }

  if (url.pathname === "/permissions/directories" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const workspaces = readScopeWorkspaces(auth);
    const placeholders = workspaces.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at FROM brain_directories WHERE workspace_id IN (${placeholders}) ORDER BY path ASC`,
    ).bind(...workspaces).all();
    return json({ ok: true, directories: results });
  }

  if (url.pathname === "/permissions/members/clearance" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; clearance_floor?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    const level = normalizeClearance(body.clearance_floor);
    if (level === null) return json({ ok: false, error: `clearance_floor must be an integer from ${CLEARANCE_MIN} to ${CLEARANCE_MAX}` }, 400);
    const result = await env.DB.prepare(`UPDATE users SET clearance_floor = ? WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`).bind(level, body.id.trim()).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Member not found" }, 404);
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: body.id.trim(), event: "member_clearance_set", payload: { clearanceFloor: level } });
    return json({ ok: true, id: body.id.trim(), clearanceFloor: level });
  }

  if (url.pathname === "/permissions/directories" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { name?: string; path?: unknown; workspace?: unknown; team?: unknown; default_clearance?: unknown; grants?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const path = cleanPath(body.path ?? body.name);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : path?.split("/").at(-1);
    if (!path || !name) return json({ ok: false, error: "name/path is required and cannot contain . or .." }, 400);
    const level = normalizeClearance(body.default_clearance);
    if (level === null) return json({ ok: false, error: `default_clearance must be an integer from ${CLEARANCE_MIN} to ${CLEARANCE_MAX}` }, 400);
    const workspace = body.workspace === "company" ? scopeWrite(auth, "company", typeof body.team === "string" ? body.team : undefined) : auth.personalWorkspaceId;
    if (body.workspace === "company" && !auth.companyWorkspaceIds.includes(workspace)) return json({ ok: false, error: "team must be one of your teams" }, 400);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(`INSERT INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).bind(id, workspace, name, path, level, auth.userId, Date.now()).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "A directory with this path already exists in the workspace" }, 409);
      throw e;
    }
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: workspace, event: "directory_created", payload: { directoryId: id, path, defaultClearance: level } });
    return json({ ok: true, directory: { id, workspace_id: workspace, name, path, default_clearance: level } }, 201);
  }

  if (url.pathname === "/permissions/directories/grants" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { directory_id?: string; user_id?: string; can_read?: boolean; can_write?: boolean; can_delete?: boolean };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.directory_id?.trim() || !body.user_id?.trim()) return json({ ok: false, error: "directory_id and user_id are required" }, 400);
    const directory = await env.DB.prepare(`SELECT workspace_id FROM brain_directories WHERE id = ?`).bind(body.directory_id.trim()).first<{ workspace_id: string }>();
    if (!directory || !auth.companyWorkspaceIds.includes(directory.workspace_id)) return json({ ok: false, error: "Directory not found in your company workspaces" }, 404);
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM memberships WHERE user_id = ? AND workspace_id = ?`).bind(body.user_id.trim(), directory.workspace_id).first();
    if (!member) return json({ ok: false, error: "User is not a member of this workspace" }, 400);
    await env.DB.prepare(`INSERT INTO brain_directory_grants (directory_id, user_id, can_read, can_write, can_delete, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(directory_id, user_id) DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write, can_delete = excluded.can_delete`).bind(body.directory_id.trim(), body.user_id.trim(), body.can_read === false ? 0 : 1, body.can_write === true ? 1 : 0, body.can_delete === true ? 1 : 0, Date.now()).run();
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: body.user_id.trim(), workspaceId: directory.workspace_id, event: "directory_grant_set", payload: { directoryId: body.directory_id.trim(), canRead: body.can_read !== false, canWrite: body.can_write === true, canDelete: body.can_delete === true } });
    return json({ ok: true });
  }

  return null;
}
