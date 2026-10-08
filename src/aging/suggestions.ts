import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { auditEventStatement } from "../lib/audit";
import { createEdge } from "../graph/edges";
import { getStatus, withStatus } from "../memory/status";
import { snapshotAndBump } from "../memory/versions";
import { titleOf } from "../export/layout";

/**
 * What the weekly aging jobs found, as a person sees it: pairs to merge and
 * contradictions to settle. Seeing a suggestion needs read access to BOTH memories
 * (a suggestion never reveals a memory its viewer could not open), and deciding
 * needs edit access to the one being retired.
 */

export interface SuggestionView {
  id: string;
  kind: "duplicate" | "contradiction";
  status: string;
  score: number;
  owner_id: string;
  created_at: number;
  detail: unknown;
  a: SideView;
  b: SideView;
}
interface SideView { id: string; title: string; excerpt: string; clearance_level: number; actor_id: string; source: string; version: number; canonical: boolean; updated_at: number }

export async function listSuggestions(
  env: Env,
  identity: Identity,
  opts: { kind?: "duplicate" | "contradiction"; status?: string; limit?: number } = {},
): Promise<SuggestionView[]> {
  const aScope = scopeWhere(identity, undefined, "a.workspace_id");
  const bScope = scopeWhere(identity, undefined, "b.workspace_id");
  const status = opts.status ?? "open";
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.kind, s.status, s.score, s.owner_id, s.created_at, s.detail,
            a.id AS a_id, a.content AS a_content, a.clearance_level AS a_level, a.actor_id AS a_actor, a.source AS a_source, a.version AS a_version, a.tags AS a_tags, COALESCE(a.updated_at, a.created_at) AS a_ts,
            b.id AS b_id, b.content AS b_content, b.clearance_level AS b_level, b.actor_id AS b_actor, b.source AS b_source, b.version AS b_version, b.tags AS b_tags, COALESCE(b.updated_at, b.created_at) AS b_ts
       FROM aging_suggestions s
       JOIN entries a ON a.id = s.a_id
       JOIN entries b ON b.id = s.b_id
      WHERE s.status = ? ${opts.kind ? "AND s.kind = ?" : ""}
        AND ${aScope.clause} AND ${bScope.clause}
        ${identity.role === "admin" ? "" : "AND (s.owner_id = ? OR a.actor_id = ? OR b.actor_id = ?)"}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
  ).bind(
    status, ...(opts.kind ? [opts.kind] : []), ...aScope.bindings, ...bScope.bindings,
    ...(identity.role === "admin" ? [] : [identity.userId, identity.userId, identity.userId]),
    Math.min(200, opts.limit ?? 50),
  ).all();
  return ((results ?? []) as Record<string, any>[]).map(r => ({
    id: r.id, kind: r.kind, status: r.status, score: r.score, owner_id: r.owner_id, created_at: r.created_at,
    detail: safeJson(r.detail),
    a: side(r, "a"), b: side(r, "b"),
  }));
}

function side(r: Record<string, any>, p: "a" | "b"): SideView {
  const content = String(r[`${p}_content`] ?? "");
  const tags = safeJson(r[`${p}_tags`]);
  return {
    id: r[`${p}_id`], title: titleOf(content), excerpt: content.slice(0, 400), clearance_level: r[`${p}_level`], actor_id: r[`${p}_actor`] ?? "",
    source: r[`${p}_source`] ?? "", version: r[`${p}_version`] ?? 1, canonical: Array.isArray(tags) && tags.includes("status:canonical"), updated_at: r[`${p}_ts`],
  };
}

function safeJson(v: unknown): any { try { return JSON.parse(String(v)); } catch { return null; } }

export type ResolveResult =
  | { ok: true; status: "resolved" | "dismissed"; kept?: string; superseded?: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * Retires `loserId` in favour of `keeperId`. Nothing is deleted: the loser's text
 * goes to the version history, it stays in the database (and in the export) as
 * `superseded`, with a link to the memory that replaced it, and recall stops
 * returning it. Reversible with `restore`.
 */
export async function supersedeEntry(env: Env, loserId: string, keeperId: string, actorId: string): Promise<void> {
  // scope-exempt: by-id: the caller (resolveSuggestion) already read this memory through getReadableEntry and checked edit rights
  const row = await env.DB.prepare(`SELECT tags, workspace_id FROM entries WHERE id = ?`).bind(loserId).first<{ tags: string; workspace_id: string }>();
  if (!row) throw new Error(`no such memory: ${loserId}`);
  await snapshotAndBump(env, loserId, { actorId, reason: "merge-superseded" });
  const tags = withStatus(JSON.parse(row.tags ?? "[]"), "deprecated");
  const now = Date.now();
  await env.DB.prepare(`UPDATE entries SET superseded_by = ?, tags = ?, updated_at = ? WHERE id = ?`).bind(keeperId, JSON.stringify(tags), now, loserId).run();
  await createEdge(keeperId, loserId, "supersedes", { provenance: "explicit", weight: 1, workspaceId: row.workspace_id }, env);
  await auditEventStatement(env, { entryId: loserId, actorId, event: "superseded", payload: { by: keeperId } }).run();
}

export async function resolveSuggestion(
  env: Env,
  identity: Identity,
  input: { id: string; action: "merge" | "dismiss"; keep?: string },
): Promise<ResolveResult> {
  const s = await env.DB.prepare(`SELECT id, kind, a_id, b_id, status, owner_id FROM aging_suggestions WHERE id = ?`)
    .bind(input.id).first<{ id: string; kind: string; a_id: string; b_id: string; status: string; owner_id: string }>();
  // Same answer for "does not exist" and "you may not see it".
  if (!s) return { ok: false, status: 404, error: "Suggestion not found" };
  const [a, b] = await Promise.all([
    getReadableEntry(env, identity, s.a_id, "id, workspace_id, actor_id, tags"),
    getReadableEntry(env, identity, s.b_id, "id, workspace_id, actor_id, tags"),
  ]);
  if (!a || !b) return { ok: false, status: 404, error: "Suggestion not found" };
  if (identity.role !== "admin" && s.owner_id !== identity.userId && a.actor_id !== identity.userId && b.actor_id !== identity.userId) {
    return { ok: false, status: 404, error: "Suggestion not found" };
  }
  if (s.status !== "open") return { ok: false, status: 409, error: `Already ${s.status}` };

  const now = Date.now();
  if (input.action === "dismiss") {
    await env.DB.prepare(`UPDATE aging_suggestions SET status = 'dismissed', resolution = 'dismissed', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
      .bind(identity.userId, now, s.id).run();
    return { ok: true, status: "dismissed" };
  }
  if (input.keep !== s.a_id && input.keep !== s.b_id) return { ok: false, status: 400, error: "keep must be one of the two memories" };
  const loser = input.keep === s.a_id ? b : a;
  const keeper = input.keep === s.a_id ? a : b;
  const denied = assertCanMutateEntry(identity, loser as { workspace_id: string; actor_id: string });
  if (denied) return { ok: false, status: 403, error: denied.message };
  // A memory the owner declared canonical is never retired by a suggestion, whoever clicks.
  const loserTags: string[] = JSON.parse((loser as { tags?: string }).tags ?? "[]");
  if (getStatus(loserTags) === "canonical") return { ok: false, status: 409, error: "A canonical memory cannot be superseded here; keep it, or change its status first." };

  await supersedeEntry(env, loser.id, keeper.id, identity.userId);
  await env.DB.prepare(`UPDATE aging_suggestions SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
    .bind(`keep:${keeper.id}`, identity.userId, now, s.id).run();
  return { ok: true, status: "resolved", kept: keeper.id, superseded: loser.id };
}

// ── memory health ────────────────────────────────────────────────────────────

export interface MemoryHealth {
  duplicates_open: number;
  contradictions_open: number;
  cold_memories: number;
  compactable_notes: number;
  compacted: number;
  superseded: number;
  archived: number;
  most_used: { id: string; title: string; access_count: number }[];
}

/** Whole-deployment counters, admin only: numbers and ids, never memory text beyond a title the viewer's own scope allows. */
export async function memoryHealth(env: Env, identity: Identity, coldDays: number, minChars: number): Promise<MemoryHealth> {
  const scope = scopeWhere(identity);
  const cold = Date.now() - coldDays * 86_400_000;
  const one = async (sql: string, ...bind: unknown[]): Promise<number> =>
    Number((await env.DB.prepare(sql).bind(...bind).first<{ n: number }>())?.n ?? 0);
  const aScope = scopeWhere(identity, undefined, "a.workspace_id");
  const bScope = scopeWhere(identity, undefined, "b.workspace_id");
  const suggestionCount = (kind: string) => one(
    `SELECT COUNT(*) AS n FROM aging_suggestions s JOIN entries a ON a.id = s.a_id JOIN entries b ON b.id = s.b_id
      WHERE s.status = 'open' AND s.kind = ? AND ${aScope.clause} AND ${bScope.clause}`, kind, ...aScope.bindings, ...bScope.bindings);
  const [duplicates_open, contradictions_open, cold_memories, compactable_notes, compacted, superseded, archived] = await Promise.all([
    suggestionCount("duplicate"),
    suggestionCount("contradiction"),
    one(`SELECT COUNT(*) AS n FROM entries WHERE ${scope.clause} AND superseded_by IS NULL AND COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) < ?`, ...scope.bindings, cold),
    one(`SELECT COUNT(*) AS n FROM entries WHERE ${scope.clause} AND tags LIKE '%"kind:episodic"%' AND tags NOT LIKE '%"status:canonical"%' AND compacted_at IS NULL AND superseded_by IS NULL AND LENGTH(content) >= ? AND COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) < ?`, ...scope.bindings, minChars, cold),
    one(`SELECT COUNT(*) AS n FROM entries WHERE ${scope.clause} AND compacted_at IS NOT NULL`, ...scope.bindings),
    one(`SELECT COUNT(*) AS n FROM entries WHERE ${scope.clause} AND superseded_by IS NOT NULL`, ...scope.bindings),
    one(`SELECT COUNT(*) AS n FROM entries WHERE ${scope.clause} AND (archived_at IS NOT NULL OR tags LIKE '%"status:deprecated"%') AND superseded_by IS NULL`, ...scope.bindings),
  ]);
  const { results } = await env.DB.prepare(
    `SELECT id, content, access_count FROM entries WHERE ${scope.clause} AND access_count > 0 ORDER BY access_count DESC, id ASC LIMIT 5`,
  ).bind(...scope.bindings).all();
  return {
    duplicates_open, contradictions_open, cold_memories, compactable_notes, compacted, superseded, archived,
    most_used: ((results ?? []) as Record<string, any>[]).map(r => ({ id: r.id, title: titleOf(String(r.content)), access_count: r.access_count })),
  };
}
