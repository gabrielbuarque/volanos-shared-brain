import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { queryVectorizeScoped } from "../vectorize/scope";
import { reembedOrDegrade, deleteStaleVectors } from "../capture/store";
import { auditEventStatement } from "../lib/audit";
import { adminAuditEvent } from "../lib/admin-audit";
import { recordJobRun, systemActor } from "../memory/jobs";
import { snapshotAndBump } from "../memory/versions";
import { getStatus } from "../memory/status";
import { findDivergences, sharedSubject, type Divergence } from "./text";
import { extractiveSummary } from "./compact";

/**
 * The three weekly memory-aging jobs. None of them calls a model, and none of
 * them changes a memory without leaving the original recoverable:
 *
 *   dedup           (AGING_DEDUP)           near-duplicates become MERGE SUGGESTIONS; a person merges
 *   contradictions  (AGING_CONTRADICTIONS)  diverging figures/dates become ALERTS; nothing is resolved
 *   compact         (AGING_COMPACT)         cold episodic notes get an extractive summary; the
 *                                           original goes to the version history and `restore` brings it back
 *
 * Each is off by default (config, `config:overrides`). Each run scans one batch
 * of memories from a cursor (so a week's run fits one Worker invocation's
 * subrequest budget) and records itself in `job_runs` and the audit logs under
 * the author `system:aging-<name>`.
 */

export type AgingJob = "dedup" | "contradictions" | "compact";
export const AGING_JOBS: readonly AgingJob[] = ["dedup", "contradictions", "compact"];

export const agingActor = (job: AgingJob): string => systemActor(`aging-${job}`);
export const jobName = (job: AgingJob): string => `aging-${job}`;

export function agingFlag(cfg: Readonly<Config>, job: AgingJob): boolean {
  const v = job === "dedup" ? cfg.AGING_DEDUP : job === "contradictions" ? cfg.AGING_CONTRADICTIONS : cfg.AGING_COMPACT;
  return String(v).trim().toLowerCase() === "on";
}

export interface AgingSummary {
  job: AgingJob;
  ok: boolean;
  enabled: boolean;
  scanned: number;
  created: number;
  /** The pass reached the end of the corpus; the next run starts over from the top. */
  cycle_complete: boolean;
  skipped?: number;
  error?: string;
  ms: number;
}

interface Cursor { ts: number; id: string }
const cursorKey = (job: AgingJob) => `aging:cursor:${job}`;

async function readCursor(env: Env, job: AgingJob): Promise<Cursor> {
  try {
    const raw = await env.OAUTH_KV.get(cursorKey(job));
    if (!raw) return { ts: 0, id: "" };
    const p = JSON.parse(raw) as Partial<Cursor>;
    return { ts: Number(p.ts) || 0, id: typeof p.id === "string" ? p.id : "" };
  } catch { return { ts: 0, id: "" }; }
}
const writeCursor = (env: Env, job: AgingJob, c: Cursor) => env.OAUTH_KV.put(cursorKey(job), JSON.stringify(c));

interface EntryRow {
  id: string; content: string; tags: string; source: string | null; actor_id: string | null; workspace_id: string;
  clearance_level: number; directory_id: string | null; source_path: string | null; vector_ids: string;
  created_at: number; ts: number; superseded_by: string | null; version?: number | null;
}

const SELECT_COLUMNS = `id, content, tags, source, actor_id, workspace_id, clearance_level, directory_id, source_path, vector_ids, created_at,
       COALESCE(updated_at, created_at) AS ts, superseded_by, version`;
const LIVE = `superseded_by IS NULL AND tags NOT LIKE '%"status:deprecated"%'`;

const tagsOf = (row: { tags: string }): string[] => { try { const v = JSON.parse(row.tags); return Array.isArray(v) ? v : []; } catch { return []; } };
const isLive = (row: EntryRow) => !row.superseded_by && getStatus(tagsOf(row)) !== "deprecated";

const sqlIn = (n: number) => Array.from({ length: n }, () => "?").join(", ");

async function nextBatch(env: Env, job: AgingJob, size: number): Promise<{ rows: EntryRow[]; cursor: Cursor; wrapped: boolean }> {
  const c = await readCursor(env, job);
  const { results } = await env.DB.prepare(
    // scope-exempt: aging job: whole-deployment system pass; rows are compared with each other inside one workspace and only ids, scores and figures are stored, shown later through scoped reads
    `SELECT ${SELECT_COLUMNS} FROM entries
      WHERE (created_at > ? OR (created_at = ? AND id > ?)) AND vector_ids != '[]' AND ${LIVE}
      ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).bind(c.ts, c.ts, c.id, size).all();
  const rows = (results ?? []) as unknown as EntryRow[];
  const last = rows.at(-1);
  return { rows, cursor: last ? { ts: last.created_at, id: last.id } : c, wrapped: rows.length < size };
}

/** Nearest neighbours of each row, by the first vector of the row. One getByIds for the whole batch. */
async function neighbours(
  env: Env, rows: EntryRow[], threshold: number, filterFor: (row: EntryRow) => Record<string, unknown>,
): Promise<Map<string, { id: string; score: number }[]>> {
  const out = new Map<string, { id: string; score: number }[]>();
  const firstVector = new Map<string, string>();
  for (const r of rows) {
    try { const v = JSON.parse(r.vector_ids); if (Array.isArray(v) && typeof v[0] === "string") firstVector.set(r.id, v[0]); } catch { /* unreadable */ }
  }
  if (!firstVector.size) return out;
  const vectors = new Map<string, number[]>();
  const fetched = await env.VECTORIZE.getByIds([...firstVector.values()]);
  for (const v of fetched) vectors.set(v.id, Array.from(v.values as ArrayLike<number>));
  for (const r of rows) {
    const vec = vectors.get(firstVector.get(r.id) ?? "");
    if (!vec) continue;
    try {
      const { matches } = await queryVectorizeScoped<{ id: string; score: number; metadata?: Record<string, unknown> }>(
        env.VECTORIZE, vec, { topK: 8, filter: filterFor(r) as never },
      );
      const best = new Map<string, number>();
      for (const m of matches) {
        const pid = String(m.metadata?.parentId ?? m.id);
        if (pid !== r.id && m.score >= threshold) best.set(pid, Math.max(best.get(pid) ?? 0, m.score));
      }
      out.set(r.id, [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score));
    } catch (e) {
      console.error(`aging: neighbour query failed for ${r.id} (non-fatal):`, e);
    }
  }
  return out;
}

async function loadRows(env: Env, ids: string[]): Promise<Map<string, EntryRow>> {
  const map = new Map<string, EntryRow>();
  if (!ids.length) return map;
  const { results } = await env.DB.prepare(
    // scope-exempt: aging job: by-id hydration of neighbours the job just found inside one workspace
    `SELECT ${SELECT_COLUMNS} FROM entries WHERE id IN (${sqlIn(ids.length)})`,
  ).bind(...ids).all();
  for (const r of (results ?? []) as unknown as EntryRow[]) map.set(r.id, r);
  return map;
}

function orderedPair(a: string, b: string): [string, string] { return a < b ? [a, b] : [b, a]; }

async function insertSuggestions(
  env: Env, job: AgingJob,
  items: { kind: "duplicate" | "contradiction"; a: EntryRow; b: EntryRow; score: number; owner: string; detail: Record<string, unknown> }[],
): Promise<number> {
  if (!items.length) return 0;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const it of items) {
    const [aId, bId] = orderedPair(it.a.id, it.b.id);
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO aging_suggestions (id, kind, workspace_id, a_id, b_id, score, detail, owner_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).bind(crypto.randomUUID(), it.kind, it.a.workspace_id, aId, bId, it.score, JSON.stringify(it.detail), it.owner, now));
  }
  const res = await env.DB.batch(statements);
  const changed = (r: unknown): number => { const m = (r as { meta?: { changes?: number; rows_written?: number } }).meta; return m?.changes ?? m?.rows_written ?? 0; };
  const created = res.filter(r => changed(r) > 0);
  // Audit only what was really created (INSERT OR IGNORE skips pairs already suggested, dismissed or resolved).
  const audit: D1PreparedStatement[] = [];
  res.forEach((r, i) => {
    if (changed(r) === 0) return;
    const it = items[i];
    audit.push(auditEventStatement(env, { entryId: it.a.id, actorId: agingActor(job), event: "aging_suggested", payload: { kind: it.kind, other_id: it.b.id, score: it.score } }));
  });
  if (audit.length) await env.DB.batch(audit);
  return created.length;
}

// ── dedup ────────────────────────────────────────────────────────────────────

export async function runDedup(env: Env, cfg: Readonly<Config>): Promise<{ scanned: number; created: number; wrapped: boolean; cursor: Cursor }> {
  const { rows, cursor, wrapped } = await nextBatch(env, "dedup", cfg.AGING_SCAN_BATCH);
  if (!rows.length) return { scanned: 0, created: 0, wrapped: true, cursor };
  const near = await neighbours(env, rows, cfg.AGING_DEDUP_THRESHOLD, r => ({
    workspace_id: { $in: [r.workspace_id] }, clearance_level: { $gte: r.clearance_level },
  }));
  const wanted = new Set<string>([...near.values()].flat().map(n => n.id));
  const others = await loadRows(env, [...wanted]);
  const items: Parameters<typeof insertSuggestions>[2] = [];
  for (const r of rows) {
    for (const n of near.get(r.id) ?? []) {
      const other = others.get(n.id);
      // Same workspace AND same level, confirmed in SQL: the vector filter is best-effort.
      if (!other || !isLive(other) || other.workspace_id !== r.workspace_id || other.clearance_level !== r.clearance_level) continue;
      const older = r.created_at <= other.created_at ? r : other;
      items.push({
        kind: "duplicate", a: r, b: other, score: Math.round(n.score * 1000) / 1000,
        owner: older.actor_id ?? "",
        detail: { similarity: n.score, clearance_level: r.clearance_level, suggested_keep: older.id },
      });
    }
  }
  const created = await insertSuggestions(env, "dedup", items);
  return { scanned: rows.length, created, wrapped, cursor };
}

// ── contradictions ───────────────────────────────────────────────────────────

/** How much a source is worth when two memories disagree (PRD precedence, step 2). Higher wins. */
export function sourceAuthority(source: string | null | undefined): number {
  const s = (source ?? "").toLowerCase();
  if (/^(bulk-ingest|github|drive|notion|upload|import|export)/.test(s)) return 3; // documents of record
  if (/^(calendar|email|imap|slack)/.test(s)) return 2;                           // records of what was said
  return 1;                                                                        // captured by a person or an agent
}

export interface Precedence {
  winner: string | null;
  rule: "canonical" | "both-canonical" | "source" | "recency" | "corroboration" | "none";
  /** Who should look at the alert: the canonical's author, else the winner's. Empty = an administrator. */
  owner: string;
}

/**
 * PRD precedence: the owner's canonical memory > authority of the source >
 * recency > corroboration. Corroboration is the LAST tiebreak and can never
 * dethrone a canonical: quantity does not change what the owner has declared true.
 */
export function decidePrecedence(
  a: { id: string; tags: readonly string[]; source: string | null; actor_id: string | null; ts: number },
  b: { id: string; tags: readonly string[]; source: string | null; actor_id: string | null; ts: number },
  corroboration: { a: number; b: number } = { a: 0, b: 0 },
): Precedence {
  const canonA = a.tags.includes("status:canonical");
  const canonB = b.tags.includes("status:canonical");
  if (canonA && canonB) return { winner: null, rule: "both-canonical", owner: "" };
  if (canonA) return { winner: a.id, rule: "canonical", owner: a.actor_id ?? "" };
  if (canonB) return { winner: b.id, rule: "canonical", owner: b.actor_id ?? "" };
  const sa = sourceAuthority(a.source), sb = sourceAuthority(b.source);
  if (sa !== sb) { const w = sa > sb ? a : b; return { winner: w.id, rule: "source", owner: w.actor_id ?? "" }; }
  if (a.ts !== b.ts) { const w = a.ts > b.ts ? a : b; return { winner: w.id, rule: "recency", owner: w.actor_id ?? "" }; }
  if (corroboration.a !== corroboration.b) { const w = corroboration.a > corroboration.b ? a : b; return { winner: w.id, rule: "corroboration", owner: w.actor_id ?? "" }; }
  return { winner: null, rule: "none", owner: "" };
}

export async function runContradictions(env: Env, cfg: Readonly<Config>): Promise<{ scanned: number; created: number; wrapped: boolean; cursor: Cursor }> {
  const { rows, cursor, wrapped } = await nextBatch(env, "contradictions", cfg.AGING_SCAN_BATCH);
  if (!rows.length) return { scanned: 0, created: 0, wrapped: true, cursor };
  const near = await neighbours(env, rows, cfg.AGING_CONTRADICTION_SIMILARITY, r => ({ workspace_id: { $in: [r.workspace_id] } }));
  const others = await loadRows(env, [...new Set([...near.values()].flat().map(n => n.id))]);
  const items: Parameters<typeof insertSuggestions>[2] = [];
  for (const r of rows) {
    const list = (near.get(r.id) ?? []).filter(n => { const o = others.get(n.id); return o && isLive(o) && o.workspace_id === r.workspace_id; });
    for (const n of list) {
      const other = others.get(n.id)!;
      const subject = sharedSubject({ tags: tagsOf(r), content: r.content }, { tags: tagsOf(other), content: other.content });
      if (!subject.tags.length && !subject.entities.length) continue;
      const divergences = findDivergences(r.content, other.content);
      if (!divergences.length) continue;
      // Corroboration: how many OTHER close memories repeat each side's figures.
      const corroboration = { a: 0, b: 0 };
      for (const m of list) {
        const third = others.get(m.id);
        if (!third || third.id === other.id) continue;
        for (const d of divergences) {
          if (d.aValues.some(v => third.content.includes(v))) corroboration.a++;
          if (d.bValues.some(v => third.content.includes(v))) corroboration.b++;
        }
      }
      const prec = decidePrecedence(
        { id: r.id, tags: tagsOf(r), source: r.source, actor_id: r.actor_id, ts: r.ts },
        { id: other.id, tags: tagsOf(other), source: other.source, actor_id: other.actor_id, ts: other.ts },
        corroboration,
      );
      const [aId] = orderedPair(r.id, other.id);
      items.push({
        kind: "contradiction", a: r, b: other, score: Math.round(n.score * 1000) / 1000, owner: prec.owner,
        detail: {
          similarity: n.score, shared_tags: subject.tags, shared_entities: subject.entities.slice(0, 8),
          divergences: orientDivergences(divergences, r.id === aId), levels: { [r.id]: r.clearance_level, [other.id]: other.clearance_level },
          precedence: { winner: prec.winner, rule: prec.rule }, corroboration: { [r.id]: corroboration.a, [other.id]: corroboration.b },
          canonical: [r, other].filter(x => tagsOf(x).includes("status:canonical")).map(x => x.id),
        },
      });
    }
  }
  const created = await insertSuggestions(env, "contradictions", items);
  return { scanned: rows.length, created, wrapped, cursor };
}

/** Divergences are computed as (r vs other); stored oriented as (a_id vs b_id). */
function orientDivergences(list: Divergence[], rIsA: boolean): Divergence[] {
  const top = list.slice(0, 3);
  return rIsA ? top : top.map(d => ({ ...d, a: d.b, b: d.a, aValues: d.bValues, bValues: d.aValues }));
}

// ── compaction ───────────────────────────────────────────────────────────────

export async function runCompact(env: Env, cfg: Readonly<Config>): Promise<{ scanned: number; created: number; skipped: number; wrapped: boolean; cursor: Cursor }> {
  const c = await readCursor(env, "compact");
  const coldBefore = Date.now() - cfg.AGING_COLD_DAYS * 86_400_000;
  const { results } = await env.DB.prepare(
    // scope-exempt: aging job: whole-deployment system pass; each row is rewritten in place at its own clearance level, with the original kept in entry_versions
    `SELECT ${SELECT_COLUMNS}, COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) AS touched FROM entries
      WHERE tags LIKE '%"kind:episodic"%' AND tags NOT LIKE '%"status:canonical"%' AND tags NOT LIKE '%"compacted"%'
        AND compacted_at IS NULL AND ${LIVE} AND LENGTH(content) >= ?
        AND COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) < ?
        AND (COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) > ? OR (COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) = ? AND id > ?))
      ORDER BY COALESCE(last_accessed_at, COALESCE(updated_at, created_at)) ASC, id ASC LIMIT ?`,
  ).bind(cfg.AGING_COMPACT_MIN_CHARS, coldBefore, c.ts, c.ts, c.id, cfg.AGING_COMPACT_BATCH).all();
  const rows = (results ?? []) as unknown as (EntryRow & { touched: number })[];
  let compacted = 0, skipped = 0;
  const actor = agingActor("compact");
  for (const r of rows) {
    const summary = extractiveSummary(r.content);
    if (!summary) { skipped++; continue; }
    try {
      const tags = [...new Set([...tagsOf(r), "compacted"])];
      const embedCtx = { workspaceId: r.workspace_id, actorId: actor, clearanceLevel: r.clearance_level, directoryId: r.directory_id, sourcePath: r.source_path };
      const oldVectors: string[] = JSON.parse(r.vector_ids ?? "[]");
      // History first: if anything below fails, the original is already safe.
      await snapshotAndBump(env, r.id, { actorId: actor, reason: "compact" });
      const stored = await reembedOrDegrade(env, r.id, summary, tags, r.source ?? "api", cfg, embedCtx);
      const now = Date.now();
      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ?, compacted_at = ? WHERE id = ?`)
        .bind(summary, JSON.stringify(tags), now, now, r.id).run();
      if (stored) { try { await deleteStaleVectors(env, oldVectors, stored.vectorIds); } catch (e) { console.error("aging: old vector cleanup failed (non-fatal):", e); } }
      await auditEventStatement(env, { entryId: r.id, actorId: actor, event: "compacted", payload: { from_chars: r.content.length, to_chars: summary.length, from_version: r.version ?? 1 } }).run();
      compacted++;
    } catch (e) {
      console.error(`aging: compaction failed for ${r.id} (non-fatal):`, e);
      skipped++;
    }
  }
  const last = rows.at(-1);
  const cursor: Cursor = last ? { ts: last.touched, id: last.id } : c;
  return { scanned: rows.length, created: compacted, skipped, wrapped: rows.length < cfg.AGING_COMPACT_BATCH, cursor };
}

// ── runner ───────────────────────────────────────────────────────────────────

export async function runAgingJob(
  env: Env,
  job: AgingJob,
  opts: { force?: boolean; actor?: string } = {},
): Promise<AgingSummary> {
  const started = Date.now();
  const cfg = await resolveConfig(env);
  const base = { job, scanned: 0, created: 0, cycle_complete: false };
  if (!agingFlag(cfg, job) && !opts.force) {
    return { ...base, ok: true, enabled: false, ms: 0 };
  }
  let summary: AgingSummary;
  try {
    const out = job === "dedup" ? await runDedup(env, cfg) : job === "contradictions" ? await runContradictions(env, cfg) : await runCompact(env, cfg);
    await writeCursor(env, job, out.wrapped ? { ts: 0, id: "" } : out.cursor);
    summary = { job, ok: true, enabled: true, scanned: out.scanned, created: out.created, cycle_complete: out.wrapped, ...("skipped" in out ? { skipped: Number(out.skipped) } : {}), ms: Date.now() - started };
  } catch (e) {
    console.error(`aging ${job} failed:`, e);
    summary = { ...base, ok: false, enabled: true, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
  const actor = opts.actor ?? agingActor(job);
  await recordJobRun(env, { job: jobName(job), actorId: actor, startedAt: started, ok: summary.ok, summary: { ...summary } });
  const pending: Promise<unknown>[] = [];
  adminAuditEvent(env, { waitUntil: p => { pending.push(p); } }, { actorId: actor, event: "aging_job_run", payload: { job, scanned: summary.scanned, created: summary.created, ok: summary.ok } });
  await Promise.allSettled(pending);
  return summary;
}
