import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { importExportPayload, type ExportEntry } from "../entries/import";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { effectiveWriteTarget, readTeamParam, scopeWrite } from "../lib/scope";
import { identityClearanceFloor, resolveWritePermission } from "../lib/permissions";
import { classifierReady, commitPlan, planIngest, summarize, type IngestFile } from "../ingest/pipeline";

const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_CHARS = 250_000;

async function stableId(path: string, content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${path}\0${content}`));
  return `bulk-${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return path.slice(0, 500);
}

/** Batch ingest for folder uploads and connector previews. Embedding is deferred
 * to /vectorize-pending, so a large folder does not burn the model quota at once. */
export async function handleIngestRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname !== "/bulk-ingest" || request.method !== "POST") return null;
  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  await initializeDatabase(env);
  let body: { files?: unknown; workspace?: unknown; team?: unknown; clearance_level?: unknown; directory_id?: unknown; dry_run?: boolean; classify?: boolean };
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!Array.isArray(body.files) || body.files.length === 0) return json({ ok: false, error: "files must be a non-empty array" }, 400);
  if (body.files.length > MAX_FILES_PER_BATCH) return json({ ok: false, error: `A batch accepts at most ${MAX_FILES_PER_BATCH} files` }, 413);
  if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
  const target = effectiveWriteTarget(auth, body.workspace);
  const team = readTeamParam(body.team, auth, target);
  if (team.error) return json({ ok: false, error: team.error }, 400);
  const workspaceId = scopeWrite(auth, target, team.teamId);
  // Classified ingest is the default whenever Jev is configured: every chunk is
  // levelled by the classifier and published or queued by fixed rules.
  // classify:false (or no key) falls back to one explicit level per file.
  const classify = body.classify === undefined ? classifierReady(env) : body.classify === true;
  if (classify && !classifierReady(env)) return json({ ok: false, error: "Jev is not configured (JEV_API_KEY); pass classify:false with an explicit clearance_level" }, 503);
  if (classify) {
    const files: IngestFile[] = [];
    const rejected: { path: string; error: string }[] = [];
    for (const raw of body.files) {
      const file = raw as Record<string, unknown>;
      const path = safeRelativePath(file?.path ?? file?.name);
      const content = file?.content;
      if (!path) { rejected.push({ path: String(file?.path ?? ""), error: "path must be a safe relative path" }); continue; }
      if (typeof content !== "string" || !content.trim()) { rejected.push({ path, error: "content is required" }); continue; }
      if (content.includes("\0")) { rejected.push({ path, error: "NUL is not allowed" }); continue; }
      if (content.length > MAX_FILE_CHARS) { rejected.push({ path, error: `file exceeds ${MAX_FILE_CHARS} characters` }); continue; }
      files.push({
        path,
        content,
        source: typeof file.source === "string" && file.source.trim() ? file.source.trim().slice(0, 80) : "bulk-ingest",
        created_at: typeof file.created_at === "number" ? file.created_at : Date.now(),
      });
    }
    if (!files.length) return json({ ok: false, imported: 0, errors: rejected }, 400);
    // scope-exempt: reads the caller's own row for a flag; no content
    const flag = await env.DB.prepare(`SELECT direct_publish AS d FROM users WHERE id = ?`).bind(auth.userId).first<{ d: number }>();
    const plan = await planIngest(env, files, { userId: auth.userId, floor: identityClearanceFloor(auth), directPublish: flag?.d === 1 });
    if (body.dry_run) {
      return json({
        ok: true, dry_run: true, classified: true, ...summarize(plan), rejected: rejected.length, errors: rejected, workspace_id: workspaceId,
        chunks: plan.chunks.map(c => ({ path: c.file.path, section: c.chunk.path, level: c.decision.level, outcome: c.decision.outcome, reason: c.decision.reason, confidence: c.classification?.confidence ?? null })),
      });
    }
    const summary = await commitPlan(env, plan, { workspaceId, actorId: auth.userId }, auth.userId);
    return json({ ok: true, classified: true, ...summary, documents: plan.docs.map(d => ({ doc_id: d.docId, path: d.path, sections: d.nodes.length, chunks: d.chunks })), rejected: rejected.length, errors: rejected, workspace_id: workspaceId });
  }
  const entries: ExportEntry[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const raw of body.files) {
    const file = raw as Record<string, unknown>;
    const path = safeRelativePath(file?.path ?? file?.name);
    const content = file?.content;
    if (!path) { errors.push({ path: String(file?.path ?? ""), error: "path must be a safe relative path" }); continue; }
    if (typeof content !== "string" || !content.trim()) { errors.push({ path, error: "content is required" }); continue; }
    if (content.includes("\0")) { errors.push({ path, error: "NUL is not allowed" }); continue; }
    if (content.length > MAX_FILE_CHARS) { errors.push({ path, error: `file exceeds ${MAX_FILE_CHARS} characters` }); continue; }
    const permission = await resolveWritePermission(env, auth, file.clearance_level ?? body.clearance_level, file.directory_id ?? body.directory_id, path);
    if (!permission.ok) { errors.push({ path, error: permission.error }); continue; }
    entries.push({
      id: await stableId(path, content),
      content,
      tags: ["bulk-ingest", `path:${path.split("/")[0].toLowerCase()}`],
      source: typeof file.source === "string" && file.source.trim() ? file.source.trim().slice(0, 80) : "bulk-ingest",
      created_at: typeof file.created_at === "number" ? file.created_at : Date.now(),
      clearance_level: permission.clearanceLevel,
      directory_id: permission.directoryId,
      source_path: permission.sourcePath,
    });
  }
  if (errors.length && !entries.length) return json({ ok: false, imported: 0, errors }, 400);
  if (body.dry_run) return json({ ok: true, dry_run: true, accepted: entries.length, rejected: errors.length, errors, workspace_id: workspaceId });
  const summary = await importExportPayload(env, { version: 2, entries }, { limit: entries.length, writeCtx: { workspaceId, actorId: auth.userId } });
  return json({ ...summary, rejected: errors.length, errors, workspace_id: workspaceId });
}
