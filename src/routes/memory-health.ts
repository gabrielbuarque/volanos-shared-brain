import type { Env } from "../env";
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { adminAuditEvent } from "../lib/admin-audit";
import { auditEvent } from "../lib/audit";
import { resolveConfig } from "../config";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { selectScopedEntries } from "../lib/scoped-entries";
import { listVersions, restoreVersion } from "../memory/versions";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { recentJobRuns } from "../memory/jobs";
import { reembedOrDegrade, deleteStaleVectors } from "../capture/store";
import { AGING_JOBS, agingFlag, runAgingJob, type AgingJob } from "../aging/jobs";
import { listSuggestions, memoryHealth, resolveSuggestion } from "../aging/suggestions";

/**
 * Memory aging surface: the "Saúde da memória" tab, the suggestions people act
 * on, and version history with restore.
 */
export async function handleMemoryHealthRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/admin/memory-health" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const cfg = await resolveConfig(env);
    const [health, runs] = await Promise.all([memoryHealth(env, auth, cfg.AGING_COLD_DAYS, cfg.AGING_COMPACT_MIN_CHARS), recentJobRuns(env, 30)]);
    return json({
      ok: true,
      flags: { dedup: agingFlag(cfg, "dedup"), contradictions: agingFlag(cfg, "contradictions"), compact: agingFlag(cfg, "compact") },
      cold_days: cfg.AGING_COLD_DAYS,
      health,
      jobs: runs.slice(0, 15),
    });
  }

  if (url.pathname === "/admin/aging/run" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { job?: unknown } = {};
    try { body = await request.json() as typeof body; } catch { /* handled below */ }
    if (typeof body.job !== "string" || !(AGING_JOBS as readonly string[]).includes(body.job)) {
      return json({ ok: false, error: `job must be one of: ${AGING_JOBS.join(", ")}` }, 400);
    }
    const summary = await runAgingJob(env, body.job as AgingJob, { actor: `admin:${auth.userId}` });
    return json({ ...summary, ...(summary.enabled ? {} : { note: `Switch it on first: PATCH /config { "AGING_${body.job === "dedup" ? "DEDUP" : body.job === "compact" ? "COMPACT" : "CONTRADICTIONS"}": "on" }` }) }, summary.ok ? 200 : 502);
  }

  if (url.pathname === "/memory/suggestions" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const kind = url.searchParams.get("kind");
    if (kind !== null && kind !== "duplicate" && kind !== "contradiction") return json({ ok: false, error: "kind must be duplicate or contradiction" }, 400);
    const status = url.searchParams.get("status") ?? "open";
    if (!["open", "resolved", "dismissed"].includes(status)) return json({ ok: false, error: "status must be open, resolved or dismissed" }, 400);
    return json({ ok: true, suggestions: await listSuggestions(env, auth, { kind: kind ?? undefined, status }) });
  }

  if (url.pathname === "/memory/suggestions/resolve" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; action?: unknown; keep?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (typeof body.id !== "string" || !body.id) return json({ ok: false, error: "id is required" }, 400);
    if (body.action !== "merge" && body.action !== "dismiss") return json({ ok: false, error: "action must be merge or dismiss" }, 400);
    const result = await resolveSuggestion(env, auth, { id: body.id, action: body.action, keep: typeof body.keep === "string" ? body.keep : undefined });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    adminAuditEvent(env, ctx, { actorId: auth.userId, event: "aging_suggestion_resolved", payload: { id: body.id, action: body.action, kept: result.kept ?? null, superseded: result.superseded ?? null } });
    return json(result);
  }

  if (url.pathname === "/entry/versions" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const id = url.searchParams.get("id")?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);
    const row = await getReadableEntry(env, auth, id, "id, workspace_id, actor_id");
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    // A version carries the level the memory had THEN: never show text above the caller's own level.
    const floor = auth.role === "admin" ? 0 : Math.max(0, Math.min(12, auth.clearanceFloor ?? 12));
    const versions = (await listVersions(env, id)).filter(v => v.clearance_level >= floor);
    // Quem fez a mudança, pelo mesmo rótulo que o resto do app usa (nunca o id cru).
    const labels = await lookupActorLabels(env, versions.map(v => v.actor_id));
    return json({ ok: true, id, versions: versions.map(v => ({ version: v.version, reason: v.reason, actor_id: v.actor_id, actor_name: resolveActorLabel(v.actor_id, labels, { viewerId: auth.userId }), created_at: v.created_at, clearance_level: v.clearance_level, content: v.content })) });
  }

  if (url.pathname === "/entry/restore" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; version?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (typeof body.id !== "string" || !body.id || typeof body.version !== "number" || !Number.isInteger(body.version)) {
      return json({ ok: false, error: "id and an integer version are required" }, 400);
    }
    const row = (await selectScopedEntries<{ id: string; workspace_id: string; actor_id: string; source: string; vector_ids: string; clearance_level: number; directory_id: string | null; source_path: string | null }>(
      env, auth, { select: "id, workspace_id, actor_id, source, vector_ids, clearance_level, directory_id, source_path", where: "id = ?", bindings: [body.id], limit: 1 },
    ))[0];
    if (!row) return json({ ok: false, error: `No entry found with ID: ${body.id}` }, 404);
    const denied = assertCanEditContent(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);
    const floor = auth.role === "admin" ? 0 : Math.max(0, Math.min(12, auth.clearanceFloor ?? 12));
    const wanted = (await listVersions(env, row.id)).find(v => v.version === body.version);
    if (!wanted || wanted.clearance_level < floor) return json({ ok: false, error: "No such version" }, 404);

    const restored = await restoreVersion(env, row.id, wanted.version, { actorId: auth.userId });
    if (!restored) return json({ ok: false, error: "No such version" }, 404);
    // Bring the vector index back in step with the restored text (degrades to keyword-only if Vectorize is down).
    try {
      const cfg = await resolveConfig(env);
      const stored = await reembedOrDegrade(env, row.id, restored.content, restored.tags, row.source, cfg, {
        workspaceId: row.workspace_id, actorId: auth.userId, clearanceLevel: row.clearance_level, directoryId: row.directory_id, sourcePath: row.source_path,
      });
      if (stored) await deleteStaleVectors(env, JSON.parse(row.vector_ids ?? "[]"), stored.vectorIds);
    } catch (e) {
      console.error("restore: re-embed failed (non-fatal, text is restored):", e);
    }
    auditEvent(env, ctx, { entryId: row.id, actorId: auth.userId, event: "restored", payload: { version: wanted.version } });
    return json({ ok: true, id: row.id, restored_version: wanted.version });
  }

  return null;
}
