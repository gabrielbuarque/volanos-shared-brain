import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { renderDoc, gitBlobSha, type ExportStatus } from "./format";
import { entryPath, historyPath, isHistoryPath, shortId, shortIdFromPath, titleOf, workspaceFolder } from "./layout";
import { GitHubRepo, RepoError, type ExportRepo, type RepoChange } from "./repo";
import { recordJobRun } from "../memory/jobs";
import { adminAuditEvent } from "../lib/admin-audit";

/**
 * The portable export: every memory as a Markdown file in a private GitHub
 * repository, one commit per run, incremental by `updated_at`.
 *
 * THE REPOSITORY HOLDS P0. Every level is exported, restricted ones included,
 * because the point is a complete backup the database can be rebuilt from. Access
 * to that repository is therefore equivalent to P0: owner and technical admin only.
 *
 * Nothing here deletes a memory. A memory forgotten in the app has its file
 * removed from the tip (git history keeps it); a memory that merely disappeared
 * from D1 is NOT removed from the repository, so a wiped or broken database can
 * never empty its own backup.
 */

export const EXPORT_CURSOR_KEY = "export:cursor";
export const EXPORT_JOB = "export";
export const EXPORT_ACTOR = "system:export";

export interface ExportCursor {
  /** Keyset position over (updated_at, id) of the last entry written. */
  ts: number;
  id: string;
  /** Keyset position over (created_at, id) of the newest entry_versions row already exported. */
  versionTs: number;
  versionId: string;
  /** Keyset position of the newest `deleted` event already applied. */
  deletedTs: number;
  deletedId: string;
  lastRunAt?: number;
  lastCommit?: string | null;
  lastMessage?: string | null;
}

export interface ExportSummary {
  ok: boolean;
  status: "committed" | "nothing" | "disabled" | "error";
  created: number;
  changed: number;
  archived: number;
  history: number;
  removed: number;
  /** More entries are waiting for the next run (the per-run cap was reached). */
  more: boolean;
  commit?: string | null;
  message?: string;
  repo?: string;
  reason?: string;
  error?: string;
  ms: number;
}

const DEFAULT_CURSOR: ExportCursor = { ts: 0, id: "", versionTs: 0, versionId: "", deletedTs: 0, deletedId: "" };

export async function readExportCursor(env: Env): Promise<ExportCursor> {
  try {
    const raw = await env.OAUTH_KV.get(EXPORT_CURSOR_KEY);
    if (!raw) return { ...DEFAULT_CURSOR };
    const p = JSON.parse(raw) as Partial<ExportCursor>;
    return {
      ts: Number(p.ts) || 0, id: typeof p.id === "string" ? p.id : "",
      versionTs: Number(p.versionTs) || 0, versionId: typeof p.versionId === "string" ? p.versionId : "",
      deletedTs: Number(p.deletedTs) || 0, deletedId: typeof p.deletedId === "string" ? p.deletedId : "",
      lastRunAt: p.lastRunAt, lastCommit: p.lastCommit ?? null, lastMessage: p.lastMessage ?? null,
    };
  } catch { return { ...DEFAULT_CURSOR }; }
}

export function exportTarget(env: Env, cfg: Readonly<Config>): { repo: string; branch: string; token: string } | null {
  const repo = (cfg.EXPORT_REPO ?? "").trim();
  const token = env.GITHUB_EXPORT_TOKEN ?? "";
  if (!repo || !token) return null;
  return { repo, branch: (cfg.EXPORT_BRANCH ?? "main").trim() || "main", token };
}

interface Row {
  id: string; content: string; tags: string; source: string | null; source_path: string | null; actor_id: string | null;
  created_at: number; ts: number; version: number | null; workspace_id: string; directory_id: string | null;
  clearance_level: number | null; superseded_by: string | null; archived_at: number | null;
  ws_name: string | null; ws_kind: string | null; dir_path: string | null;
}

export function statusOf(row: Pick<Row, "superseded_by" | "archived_at">, tags: string[]): ExportStatus {
  if (row.superseded_by) return "superseded";
  if (row.archived_at || tags.includes("status:deprecated")) return "archived";
  return "active";
}

export function entryDoc(row: Row): { path: string; text: string; status: ExportStatus } {
  const tags: string[] = safeArray(row.tags);
  const status = statusOf(row, tags);
  const workspace = { id: row.workspace_id, name: row.ws_name, kind: row.ws_kind };
  const text = renderDoc({
    id: row.id,
    title: titleOf(row.content),
    clearance_level: row.clearance_level ?? 12,
    workspace_id: row.workspace_id,
    directory_id: row.directory_id,
    source: row.source ?? "",
    source_path: row.source_path,
    author: row.actor_id ?? "",
    created_at: row.created_at,
    updated_at: row.ts,
    version: row.version ?? 1,
    status,
    canonical: tags.includes("status:canonical"),
    tags,
    superseded_by: row.superseded_by,
    workspace_name: row.ws_name ?? "",
    workspace_kind: row.ws_kind ?? "personal",
    directory_path: row.dir_path,
  }, row.content);
  return { path: entryPath({ workspace, directoryPath: row.dir_path, content: row.content, id: row.id }), text, status };
}

function safeArray(raw: string | null): string[] {
  try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []; } catch { return []; }
}

export async function runExport(
  env: Env,
  opts: { actor?: string; repo?: ExportRepo; now?: number; maxEntries?: number } = {},
): Promise<ExportSummary> {
  const started = Date.now();
  const cfg = await resolveConfig(env);
  const empty = { created: 0, changed: 0, archived: 0, history: 0, removed: 0, more: false };
  const finish = (s: Omit<ExportSummary, "ms" | "created" | "changed" | "archived" | "history" | "removed" | "more"> & Partial<ExportSummary>): ExportSummary => ({ ...empty, ...s, ms: Date.now() - started });

  let repo = opts.repo;
  if (!repo) {
    const target = exportTarget(env, cfg);
    if (!target) {
      const reason = "Set config.EXPORT_REPO (owner/repository) and the GITHUB_EXPORT_TOKEN secret to turn the export on.";
      return finish({ ok: false, status: "disabled", reason, error: reason });
    }
    repo = new GitHubRepo(target.token, target.repo, target.branch);
  }

  const actor = opts.actor ?? EXPORT_ACTOR;
  const cap = Math.max(1, Math.min(5000, opts.maxEntries ?? cfg.EXPORT_MAX_ENTRIES_PER_RUN));
  let summary: ExportSummary;
  try {
    summary = await exportOnce(env, repo, cursorKeyed(await readExportCursor(env)), cap, opts.now ?? Date.now(), finish);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("export failed:", e);
    summary = finish({ ok: false, status: "error", error, repo: repo.describe() });
  }
  await recordJobRun(env, { job: EXPORT_JOB, actorId: actor, startedAt: started, ok: summary.ok, summary: { ...summary } });
  if (summary.status !== "disabled") {
    const pending: Promise<unknown>[] = [];
    adminAuditEvent(env, { waitUntil: p => { pending.push(p); } }, {
      actorId: actor, event: "export_run",
      payload: { status: summary.status, created: summary.created, changed: summary.changed, archived: summary.archived, history: summary.history, removed: summary.removed, commit: summary.commit ?? null },
    });
    await Promise.allSettled(pending);
  }
  return summary;
}

const cursorKeyed = (c: ExportCursor) => c;

async function exportOnce(
  env: Env,
  repo: ExportRepo,
  cursor: ExportCursor,
  cap: number,
  now: number,
  finish: (s: any) => ExportSummary,
): Promise<ExportSummary> {
  /* The whole deployment, every level, by design: this IS the backup. Output goes only to the private export repository. */
  const { results } = await env.DB.prepare(
    // scope-exempt: export job: whole-deployment backup including P0 by design (documented in docs/volanos/export.md); output leaves only to the private export repository
    `SELECT e.id, e.content, e.tags, e.source, e.source_path, e.actor_id, e.created_at,
            COALESCE(e.updated_at, e.created_at) AS ts, e.version, e.workspace_id, e.directory_id, e.clearance_level,
            e.superseded_by, e.archived_at, w.name AS ws_name, w.kind AS ws_kind, d.path AS dir_path
       FROM entries e
       LEFT JOIN workspaces w ON w.id = e.workspace_id
       LEFT JOIN brain_directories d ON d.id = e.directory_id
      WHERE COALESCE(e.updated_at, e.created_at) > ? OR (COALESCE(e.updated_at, e.created_at) = ? AND e.id > ?)
      ORDER BY COALESCE(e.updated_at, e.created_at) ASC, e.id ASC
      LIMIT ?`,
  ).bind(cursor.ts, cursor.ts, cursor.id, cap).all();
  const rows = (results ?? []) as unknown as Row[];
  const more = rows.length === cap;

  const { results: versionRows } = await env.DB.prepare(
    // scope-exempt: export job: whole-deployment backup including P0 by design; history rows go only to the private export repository
    `SELECT v.id AS vid, v.entry_id, v.version, v.content, v.tags, v.clearance_level, v.directory_id, v.source_path, v.actor_id, v.reason, v.created_at,
            e.workspace_id, w.name AS ws_name, w.kind AS ws_kind
       FROM entry_versions v
       JOIN entries e ON e.id = v.entry_id
       LEFT JOIN workspaces w ON w.id = e.workspace_id
      WHERE v.created_at > ? OR (v.created_at = ? AND v.id > ?)
      ORDER BY v.created_at ASC, v.id ASC
      LIMIT ?`,
  ).bind(cursor.versionTs, cursor.versionTs, cursor.versionId, cap).all();
  const versions = (versionRows ?? []) as unknown as Record<string, any>[];

  const { results: deletedRows } = await env.DB.prepare(
    `SELECT id, entry_id, created_at FROM entry_events WHERE event = 'deleted' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT 500`,
  ).bind(cursor.deletedTs, cursor.deletedTs, cursor.deletedId).all();
  const deleted = (deletedRows ?? []) as unknown as { id: string; entry_id: string; created_at: number }[];

  if (!rows.length && !versions.length && !deleted.length) {
    return finish({ ok: true, status: "nothing", repo: repo.describe(), message: "export: 0 novas, 0 alteradas, 0 arquivadas" });
  }

  const snap = await repo.snapshot();
  if (snap.truncated) throw new RepoError("The export repository is too large to list in one call; split it or start a new one.");
  const bySha = new Map(snap.files.map(f => [f.path, f.sha]));
  const pathsByShort = new Map<string, string[]>();
  const historyByShort = new Map<string, string[]>();
  for (const f of snap.files) {
    const s = shortIdFromPath(f.path);
    if (s) pathsByShort.set(s, [...(pathsByShort.get(s) ?? []), f.path]);
    else if (isHistoryPath(f.path)) {
      const h = f.path.split("/").at(-2) ?? "";
      historyByShort.set(h, [...(historyByShort.get(h) ?? []), f.path]);
    }
  }

  const changes: RepoChange[] = [];
  const queued = new Map<string, string | null>();
  const queue = (path: string, content: string | null) => { queued.set(path, content); };
  let created = 0, changed = 0, archived = 0, history = 0, removed = 0;

  for (const row of rows) {
    const doc = entryDoc(row);
    const existing = (pathsByShort.get(shortId(row.id)) ?? []);
    const sameFile = bySha.get(doc.path) === await gitBlobSha(doc.text);
    // A title edit moves the file: drop the old path(s) for this id.
    for (const old of existing) if (old !== doc.path) queue(old, null);
    if (sameFile && existing.every(p => p === doc.path)) continue;
    queue(doc.path, doc.text);
    if (existing.length) changed++; else created++;
    if (doc.status !== "active") archived++;
  }

  for (const v of versions) {
    const folder = workspaceFolder({ id: v.workspace_id, name: v.ws_name, kind: v.ws_kind });
    const path = historyPath(folder, v.entry_id, Number(v.version));
    const text = renderDoc({
      id: v.entry_id, version: Number(v.version), clearance_level: v.clearance_level ?? 12, directory_id: v.directory_id ?? null,
      source_path: v.source_path ?? null, author: v.actor_id ?? "", reason: v.reason ?? "", updated_at: v.created_at,
      tags: safeArray(v.tags), workspace_id: v.workspace_id,
    }, String(v.content));
    if (bySha.get(path) === await gitBlobSha(text)) continue;
    queue(path, text);
    history++;
  }

  for (const d of deleted) {
    const s = shortId(d.entry_id);
    for (const p of [...(pathsByShort.get(s) ?? []), ...(historyByShort.get(s) ?? [])]) {
      if (!queued.has(p)) { queue(p, null); removed++; }
    }
  }

  for (const [path, content] of queued) changes.push({ path, content });
  const message = `export: ${created} novas, ${changed} alteradas, ${archived} arquivadas`;
  const last = rows.at(-1);
  const next: ExportCursor = {
    ts: last ? last.ts : cursor.ts,
    id: last ? last.id : cursor.id,
    versionTs: versions.length ? Number(versions.at(-1)!.created_at) : cursor.versionTs,
    versionId: versions.length ? String(versions.at(-1)!.vid) : cursor.versionId,
    deletedTs: deleted.length ? deleted.at(-1)!.created_at : cursor.deletedTs,
    deletedId: deleted.length ? deleted.at(-1)!.id : cursor.deletedId,
  };

  let commit: string | null = null;
  if (changes.length) {
    const detail = [removed ? `${removed} removidas (esquecidas no app)` : "", history ? `${history} versões anteriores` : ""].filter(Boolean).join("; ");
    commit = await repo.commit(snap, changes, detail ? `${message}\n\n${detail}` : message);
  }
  await writeCursor(env, { ...next, lastRunAt: now, lastCommit: commit ?? cursor.lastCommit ?? null, lastMessage: changes.length ? message : cursor.lastMessage ?? null });
  return finish({
    ok: true, status: commit ? "committed" : "nothing", created, changed, archived, history, removed, more,
    commit, message: commit ? message : "export: 0 novas, 0 alteradas, 0 arquivadas", repo: repo.describe(),
  });
}

async function writeCursor(env: Env, cursor: ExportCursor): Promise<void> {
  await env.OAUTH_KV.put(EXPORT_CURSOR_KEY, JSON.stringify(cursor));
}

/** Test and admin helper: forget the cursor so the next run exports everything again. */
export async function resetExportCursor(env: Env): Promise<void> {
  await env.OAUTH_KV.delete(EXPORT_CURSOR_KEY);
}
