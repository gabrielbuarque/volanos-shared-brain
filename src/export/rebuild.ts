import type { Env } from "../env";
import { resolveConfig } from "../config";
import { normalizeClearance } from "../lib/permissions";
import { storeEntry } from "../capture/store";
import { parseDoc, UPDATED_KEY } from "./format";
import { isHistoryPath, shortId } from "./layout";
import type { ExportRepo, RepoFile } from "./repo";
import { recordJobRun } from "../memory/jobs";

/**
 * Rebuilds the database from the export repository: memories, their clearance
 * levels, directories, workspaces and version history. Idempotent by memory id
 * (running it twice, or on a database that already has some of the memories,
 * changes nothing that is already there), resumable in slices (`offset`/`limit`,
 * because every file is one GitHub call), and dry-runnable.
 *
 * Embeddings are not in the files: rebuilt memories get `vector_ids = '[]'`, which
 * is exactly the state the existing repair backlog (`POST /vectorize-pending`,
 * and the optional `embed_limit` here) re-embeds from. Keyword search works the
 * moment the rows exist.
 *
 * Accounts and ACL grants are not in the files either; they are re-created in the
 * app. A restored company workspace attaches to the deployment's company workspace
 * when the exported id does not exist here (see `workspace_map` to be explicit).
 */

export const REBUILD_JOB = "rebuild-from-export";
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 1000;

export interface RebuildOptions {
  dryRun: boolean;
  offset?: number;
  limit?: number;
  /** exported workspace id -> workspace id to use here. */
  workspaceMap?: Record<string, string>;
  /** Embed up to this many rebuilt memories at the end of the last slice. */
  embedLimit?: number;
  actor: string;
}

export interface RebuildSummary {
  ok: boolean;
  dry_run: boolean;
  files_total: number;
  offset: number;
  processed: number;
  next_offset: number | null;
  entries_created: number;
  entries_updated: number;
  entries_unchanged: number;
  entries_kept_newer: number;
  versions_created: number;
  versions_unchanged: number;
  workspaces_created: number;
  directories_created: number;
  skipped_files: string[];
  mapped_workspaces: Record<string, string>;
  errors: { path: string; error: string }[];
  pending_embeddings: number | null;
  embedded: number;
}

const isDocPath = (p: string): boolean => p.endsWith(".md") && !p.startsWith(".") && !p.startsWith(".github/");

function str(v: unknown, fallback = ""): string { return typeof v === "string" ? v : fallback; }
function num(v: unknown, fallback = 0): number { return typeof v === "number" && Number.isFinite(v) ? v : fallback; }

export async function rebuildFromExport(env: Env, repo: ExportRepo, opts: RebuildOptions): Promise<RebuildSummary> {
  const started = Date.now();
  const snap = await repo.snapshot();
  const docs = snap.files.filter(f => isDocPath(f.path));
  const ordered = [
    ...docs.filter(f => !isHistoryPath(f.path)).sort((a, b) => a.path.localeCompare(b.path)),
    ...docs.filter(f => isHistoryPath(f.path)).sort((a, b) => a.path.localeCompare(b.path)),
  ];
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(opts.limit ?? DEFAULT_LIMIT)));
  const slice = ordered.slice(offset, offset + limit);

  const summary: RebuildSummary = {
    ok: true, dry_run: opts.dryRun, files_total: ordered.length, offset, processed: 0,
    next_offset: offset + slice.length < ordered.length ? offset + slice.length : null,
    entries_created: 0, entries_updated: 0, entries_unchanged: 0, entries_kept_newer: 0,
    versions_created: 0, versions_unchanged: 0, workspaces_created: 0, directories_created: 0,
    skipped_files: [], mapped_workspaces: {}, errors: [], pending_embeddings: null, embedded: 0,
  };

  const wsCache = new Map<string, string>();
  for (const file of slice) {
    try {
      const text = await repo.read(file);
      const doc = parseDoc(text);
      if (!doc || typeof doc.meta.id !== "string" || !doc.meta.id) { summary.skipped_files.push(file.path); continue; }
      if (isHistoryPath(file.path)) await restoreVersionFile(env, doc, opts, summary);
      else await restoreEntryFile(env, doc, opts, summary, wsCache);
      summary.processed++;
    } catch (e) {
      summary.errors.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  summary.ok = summary.errors.length === 0;

  if (summary.next_offset === null) {
    // scope-exempt: rebuild job: admin-only counter of memories waiting for embeddings, returns a number
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE vector_ids = '[]'`).first<{ n: number }>();
    summary.pending_embeddings = row?.n ?? 0;
    if (!opts.dryRun && (opts.embedLimit ?? 0) > 0) summary.embedded = await embedPending(env, opts.embedLimit!);
  }
  if (!opts.dryRun) {
    await recordJobRun(env, { job: REBUILD_JOB, actorId: opts.actor, startedAt: started, ok: summary.ok, summary: { ...summary, skipped_files: summary.skipped_files.length } });
  }
  return summary;
}

async function resolveWorkspace(
  env: Env,
  doc: { meta: Record<string, unknown> },
  opts: RebuildOptions,
  summary: RebuildSummary,
  cache: Map<string, string>,
): Promise<string> {
  const exported = str(doc.meta.workspace_id);
  const cached = cache.get(exported);
  if (cached !== undefined) return cached;
  const explicit = opts.workspaceMap?.[exported];
  let target = explicit ?? exported;
  const kind = str(doc.meta.workspace_kind, "personal") === "company" ? "company" : "personal";
  const existing = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(target).first<{ id: string }>();
  if (!existing && !explicit && kind === "company") {
    // The deployment already has its own company workspace: attach the restored company memories to it.
    const company = await env.DB.prepare(`SELECT id FROM workspaces WHERE kind = 'company' ORDER BY created_at LIMIT 1`).first<{ id: string }>();
    if (company) target = company.id;
  }
  if (target !== exported) summary.mapped_workspaces[exported] = target;
  if (exported !== "" && !(await env.DB.prepare(`SELECT 1 AS ok FROM workspaces WHERE id = ?`).bind(target).first())) {
    summary.workspaces_created++;
    if (!opts.dryRun) {
      await env.DB.prepare(`INSERT OR IGNORE INTO workspaces (id, kind, name, created_at) VALUES (?, ?, ?, ?)`)
        .bind(target, kind, str(doc.meta.workspace_name), Date.now()).run();
    }
  }
  cache.set(exported, target);
  return target;
}

async function resolveDirectory(
  env: Env, workspaceId: string, doc: { meta: Record<string, unknown> }, opts: RebuildOptions, summary: RebuildSummary,
): Promise<string | null> {
  const id = typeof doc.meta.directory_id === "string" && doc.meta.directory_id ? doc.meta.directory_id : null;
  if (!id) return null;
  const path = str(doc.meta.directory_path) || id;
  const byId = await env.DB.prepare(`SELECT id FROM brain_directories WHERE id = ?`).bind(id).first<{ id: string }>();
  if (byId) return id;
  // The same path may already exist under another id (a directory recreated by hand): reuse it.
  const byPath = await env.DB.prepare(`SELECT id FROM brain_directories WHERE workspace_id = ? AND path = ?`).bind(workspaceId, path).first<{ id: string }>();
  if (byPath) return byPath.id;
  summary.directories_created++;
  if (!opts.dryRun) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at) VALUES (?, ?, NULL, ?, ?, 12, ?, ?)`,
    ).bind(id, workspaceId, path.split("/").at(-1) ?? path, path, str(doc.meta.author) || "system:rebuild", Date.now()).run();
  }
  return id;
}

async function restoreEntryFile(
  env: Env,
  doc: { meta: Record<string, unknown>; body: string },
  opts: RebuildOptions,
  summary: RebuildSummary,
  cache: Map<string, string>,
): Promise<void> {
  const id = String(doc.meta.id);
  const level = normalizeClearance(doc.meta.clearance_level);
  if (level === null) throw new Error("invalid clearance_level");
  const workspaceId = await resolveWorkspace(env, doc, opts, summary, cache);
  const directoryId = await resolveDirectory(env, workspaceId, doc, opts, summary);
  const tags = Array.isArray(doc.meta.tags) ? doc.meta.tags.filter((t): t is string => typeof t === "string") : [];
  const createdAt = num(doc.meta.created_at, Date.now());
  const updatedAt = num(doc.meta[UPDATED_KEY], createdAt);
  const version = Math.max(1, Math.trunc(num(doc.meta.version, 1)));
  const status = str(doc.meta.status, "active");
  const supersededBy = typeof doc.meta.superseded_by === "string" && doc.meta.superseded_by ? doc.meta.superseded_by : null;
  const archivedAt = status === "archived" ? updatedAt : null;

  const existing = await env.DB.prepare(
    // scope-exempt: rebuild job: admin-only restore of the backup, idempotency probe by primary key; the row is compared, never returned
    `SELECT content, tags, clearance_level, COALESCE(updated_at, created_at) AS ts, version FROM entries WHERE id = ?`,
  ).bind(id).first<{ content: string; tags: string; clearance_level: number; ts: number; version: number }>();

  if (!existing) {
    summary.entries_created++;
    if (opts.dryRun) return;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id, source_path, version, superseded_by, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, doc.body, JSON.stringify(tags), str(doc.meta.source, "export"), createdAt, updatedAt, workspaceId, str(doc.meta.author), level,
      directoryId, typeof doc.meta.source_path === "string" ? doc.meta.source_path : null, version, supersededBy, archivedAt).run();
    return;
  }

  const same = existing.content === doc.body && existing.clearance_level === level && existing.tags === JSON.stringify(tags);
  if (same) { summary.entries_unchanged++; return; }
  // The database wins ties and anything newer: a rebuild must never roll back work done since the export.
  if (existing.ts >= updatedAt && Number(existing.version ?? 1) >= version) { summary.entries_kept_newer++; return; }
  summary.entries_updated++;
  if (opts.dryRun) return;
  await env.DB.prepare(
    // scope-exempt: rebuild job: admin-only restore; copies the row being replaced into its own history
    `INSERT OR IGNORE INTO entry_versions (id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at)
     SELECT ?, id, version, content, tags, clearance_level, directory_id, source_path, ?, 'import', ? FROM entries WHERE id = ?`,
  ).bind(`ver-${crypto.randomUUID()}`, opts.actor, Date.now(), id).run();
  await env.DB.prepare(
    `UPDATE entries SET content = ?, tags = ?, updated_at = ?, clearance_level = ?, directory_id = ?, version = ?, superseded_by = ?, archived_at = ?, vector_ids = '[]' WHERE id = ?`,
  ).bind(doc.body, JSON.stringify(tags), updatedAt, level, directoryId, Math.max(version, Number(existing.version ?? 1) + 1), supersededBy, archivedAt, id).run();
}

async function restoreVersionFile(
  env: Env, doc: { meta: Record<string, unknown>; body: string }, opts: RebuildOptions, summary: RebuildSummary,
): Promise<void> {
  const entryId = String(doc.meta.id);
  const version = Math.trunc(num(doc.meta.version, 0));
  if (version < 1) throw new Error("invalid version");
  const level = normalizeClearance(doc.meta.clearance_level) ?? 12;
  const rowId = `ver-${shortId(entryId)}-${version}`;
  const exists = await env.DB.prepare(`SELECT 1 AS ok FROM entry_versions WHERE entry_id = ? AND version = ?`).bind(entryId, version).first();
  if (exists) { summary.versions_unchanged++; return; }
  summary.versions_created++;
  if (opts.dryRun) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entry_versions (id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(rowId, entryId, version, doc.body, JSON.stringify(Array.isArray(doc.meta.tags) ? doc.meta.tags : []), level,
    typeof doc.meta.directory_id === "string" ? doc.meta.directory_id : null,
    typeof doc.meta.source_path === "string" ? doc.meta.source_path : null,
    str(doc.meta.author), str(doc.meta.reason, "import"), num(doc.meta[UPDATED_KEY], Date.now())).run();
}

/** Re-embeds rebuilt memories (bounded). Uses the same path the repair backlog uses, with each row's own workspace and level. */
export async function embedPending(env: Env, limit: number): Promise<number> {
  const cfg = await resolveConfig(env);
  const { results } = await env.DB.prepare(
    // scope-exempt: rebuild job: admin repair backlog, the rows go to the embedder only
    `SELECT id, content, tags, source, created_at, workspace_id, actor_id, clearance_level, directory_id, source_path FROM entries WHERE vector_ids = '[]' ORDER BY created_at ASC LIMIT ?`,
  ).bind(limit).all();
  let done = 0;
  for (const row of (results ?? []) as Record<string, any>[]) {
    try {
      await storeEntry(env, row.id, row.content, JSON.parse(row.tags ?? "[]"), row.source, row.created_at, cfg, {
        workspaceId: row.workspace_id, actorId: row.actor_id, clearanceLevel: row.clearance_level, directoryId: row.directory_id, sourcePath: row.source_path,
      });
      done++;
    } catch (e) {
      console.error("rebuild: embedding failed for", row.id, e);
    }
  }
  return done;
}

export type { RepoFile };
