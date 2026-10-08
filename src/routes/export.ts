import type { Env } from "../env";
import { json } from "../lib/http";
import { requireAdmin } from "../lib/identity";
import { adminAuditEvent } from "../lib/admin-audit";
import { resolveConfig } from "../config";
import { GitHubRepo, RepoError } from "../export/repo";
import { exportTarget, readExportCursor, runExport } from "../export/run";
import { rebuildFromExport } from "../export/rebuild";
import { recentJobRuns } from "../memory/jobs";

/**
 * Markdown export and rebuild. Admin only, and deliberately so: the export
 * repository contains EVERY memory, P0 included, so whoever can read it can read
 * everything (docs/volanos/export.md).
 */
export async function handleExportRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/admin/export/status" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const cfg = await resolveConfig(env);
    const target = exportTarget(env, cfg);
    const cursor = await readExportCursor(env);
    const runs = (await recentJobRuns(env, 50)).filter(r => r.job === "export").slice(0, 10);
    return json({
      ok: true,
      enabled: target !== null,
      repo: cfg.EXPORT_REPO || null,
      branch: cfg.EXPORT_BRANCH || "main",
      token_configured: Boolean(env.GITHUB_EXPORT_TOKEN),
      last_run_at: cursor.lastRunAt ?? null,
      last_commit: cursor.lastCommit ?? null,
      last_message: cursor.lastMessage ?? null,
      schedule: "diário, 06:30 UTC (03:30 America/Fortaleza)",
      warning: "O repositório de exportação contém P0 (todos os níveis). Acesso a ele equivale a acesso P0: restrinja ao dono e ao admin técnico.",
      runs,
    });
  }

  if (url.pathname === "/admin/export-now" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const summary = await runExport(env, { actor: `admin:${auth.userId}` });
    return json(summary, summary.status === "error" ? 502 : summary.status === "disabled" ? 409 : 200);
  }

  if (url.pathname === "/admin/rebuild-from-export" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { dry_run?: unknown; offset?: unknown; limit?: unknown; workspace_map?: unknown; embed_limit?: unknown } = {};
    try { body = await request.json() as typeof body; } catch { /* an empty body is a dry run */ }
    // A rebuild writes rows; make the harmless reading the default and the write explicit.
    const dryRun = body.dry_run !== false;
    const cfg = await resolveConfig(env);
    const target = exportTarget(env, cfg);
    if (!target) return json({ ok: false, error: "Set config.EXPORT_REPO (owner/repository) and the GITHUB_EXPORT_TOKEN secret first." }, 409);
    const map: Record<string, string> = {};
    if (body.workspace_map && typeof body.workspace_map === "object" && !Array.isArray(body.workspace_map)) {
      for (const [k, v] of Object.entries(body.workspace_map as Record<string, unknown>)) if (typeof v === "string" && v) map[k] = v;
    }
    try {
      const summary = await rebuildFromExport(env, new GitHubRepo(target.token, target.repo, target.branch), {
        dryRun,
        offset: typeof body.offset === "number" ? body.offset : 0,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        workspaceMap: map,
        embedLimit: typeof body.embed_limit === "number" ? Math.max(0, Math.min(200, body.embed_limit)) : 0,
        actor: auth.userId,
      });
      if (!dryRun) adminAuditEvent(env, ctx, { actorId: auth.userId, event: "rebuild_from_export", payload: { offset: summary.offset, processed: summary.processed, created: summary.entries_created, updated: summary.entries_updated, versions: summary.versions_created } });
      return json(summary, summary.ok ? 200 : 207);
    } catch (e) {
      const status = e instanceof RepoError && e.status ? 502 : 500;
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, status);
    }
  }

  return null;
}
