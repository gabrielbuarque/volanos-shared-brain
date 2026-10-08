import type { Env } from "../env";
import { importExportPayload, type ExportEntry } from "../entries/import";
import type { WriteContext } from "../lib/scope";
import { decide, type Decision } from "./decide";
import { classifyChunks, jevConfigured, type ClassifyResult } from "./jev";
import { getLevels } from "./levels";
import { nodesWithContent, parseMarkdown, type Chunk, type TreeNode } from "./tree";

export interface IngestFile {
  path: string;
  content: string;
  source: string;
  created_at: number;
}

export interface Submitter {
  userId: string;
  /** Lowest level they publish at without approval (0 for an admin). */
  floor: number;
  directPublish: boolean;
}

export interface PlannedChunk {
  docId: string;
  file: IngestFile;
  chunk: Chunk;
  node: TreeNode;
  classification: ClassifyResult;
  decision: Decision;
  id: string;
}

export interface IngestPlan {
  docs: { docId: string; path: string; nodes: TreeNode[]; chunks: number }[];
  chunks: PlannedChunk[];
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Parse, classify and decide. Writes nothing, so dry runs and the live path share it. */
export async function planIngest(env: Env, files: IngestFile[], who: Submitter): Promise<IngestPlan> {
  const levels = await getLevels(env);
  const parsed = await Promise.all(files.map(async file => {
    const docId = `doc-${(await sha(`${file.path}\0${file.content}`)).slice(0, 24)}`;
    return { docId, file, doc: parseMarkdown(file.content, file.path.split("/").at(-1) ?? "Documento") };
  }));
  const flat = parsed.flatMap(p => p.doc.chunks.map(chunk => ({ p, chunk })));
  const results = await classifyChunks(env, flat.map(f => f.chunk), levels);
  const chunks: PlannedChunk[] = [];
  for (let i = 0; i < flat.length; i++) {
    const { p, chunk } = flat[i];
    const node = p.doc.nodes.find(n => n.id === chunk.nodeId)!;
    chunks.push({
      docId: p.docId,
      file: p.file,
      chunk,
      node,
      classification: results[i],
      decision: decide(results[i], who),
      id: `bulk-${(await sha(`${p.docId}\0${chunk.index}\0${chunk.text}`)).slice(0, 48)}`,
    });
  }
  return {
    docs: parsed.map(p => ({ docId: p.docId, path: p.file.path, nodes: nodesWithContent(p.doc), chunks: p.doc.chunks.length })),
    chunks,
  };
}

export interface IngestSummary {
  published: number;
  quarantined: number;
  flagged_for_review: number;
  already_present: number;
  by_level: Record<string, number>;
}

export function summarize(plan: IngestPlan): Omit<IngestSummary, "already_present"> {
  const by_level: Record<string, number> = {};
  let published = 0, quarantined = 0, flagged = 0;
  for (const c of plan.chunks) {
    const key = `P${c.decision.level}`;
    by_level[key] = (by_level[key] ?? 0) + 1;
    if (c.decision.outcome === "publish") published++; else quarantined++;
    if (c.decision.review) flagged++;
  }
  return { published, quarantined, flagged_for_review: flagged, by_level };
}

const BATCH = 50;

/** Persist a plan: published chunks become entries, quarantined ones become approval requests. */
export async function commitPlan(env: Env, plan: IngestPlan, writeCtx: WriteContext, submitterId: string): Promise<IngestSummary> {
  const now = Date.now();
  const publish = plan.chunks.filter(c => c.decision.outcome === "publish");
  const quarantine = plan.chunks.filter(c => c.decision.outcome === "quarantine");
  let imported = 0;

  if (publish.length) {
    const entries: ExportEntry[] = publish.map(c => ({
      id: c.id,
      content: c.chunk.text,
      tags: ["bulk-ingest", `doc:${c.docId}`, `path:${c.file.path.split("/")[0].toLowerCase()}`],
      source: c.file.source,
      created_at: c.file.created_at,
      clearance_level: c.decision.level,
      source_path: c.file.path,
    }));
    const summary = await importExportPayload(env, { version: 2, entries }, { limit: entries.length, writeCtx: { ...writeCtx, actorId: submitterId } });
    imported = summary.imported;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const d of plan.docs) {
    for (const n of d.nodes) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO doc_nodes (doc_id, node_id, workspace_id, parent_id, title, path, ord, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(d.docId, n.id, writeCtx.workspaceId, n.parentId, n.title, n.path, n.ord, d.path, now));
    }
  }
  for (const c of publish) {
    const cl = c.classification;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO entry_classification (entry_id, doc_id, node_id, ord, jev_level, confidence, top3, review, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(c.id, c.docId, c.node.id, c.chunk.index, cl?.level ?? null, cl?.confidence ?? null, JSON.stringify(cl?.top3 ?? []), c.decision.review ? 1 : 0, cl?.model ?? "", now));
  }
  for (const c of quarantine) {
    const cl = c.classification;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO contributions (id, workspace_id, submitter_id, doc_id, node_id, ord, source, source_path, content, suggested_level, confidence, top3, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(`contrib-${c.id.slice(5)}`, writeCtx.workspaceId, submitterId, c.docId, c.node.id, c.chunk.index, c.file.source, c.file.path, c.chunk.text, c.decision.level, cl?.confidence ?? null, JSON.stringify(cl?.top3 ?? []), c.decision.reason, now));
  }
  for (let i = 0; i < stmts.length; i += BATCH) await env.DB.batch(stmts.slice(i, i + BATCH));

  const base = summarize(plan);
  return { ...base, already_present: publish.length - imported };
}

export function classifierReady(env: Env): boolean {
  return jevConfigured(env);
}
