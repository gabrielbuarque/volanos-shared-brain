import type { Env } from "../env";
import { resolveConfig } from "../config";
import { importExportPayload } from "../entries/import";
import { getLevels, saveLevels } from "../ingest/levels";
import { adminAuditEvent } from "../lib/admin-audit";
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { CLEARANCE_MAX, identityClearanceFloor, normalizeClearance } from "../lib/permissions";
import { readableWorkspaces, scopeWhere } from "../lib/scope";
import { chat, chatText, streamWithMeta } from "../llm/provider";
import { ANSWER_SYSTEM, answerContext, parseNodeChoice, pruneTree, treePrompt, type ReadableChunk } from "../pageindex";
import { CORS_HEADERS } from "../lib/http";

/**
 * Routes for the Shared Brain pilot: level texts, the contribution approval
 * queue, and PageIndex answers over one document.
 */
export async function handleSharedBrainRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname;

  // ── Level texts ───────────────────────────────────────────────────────────
  if (path === "/levels" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, levels: await getLevels(env), yours: identityClearanceFloor(auth) });
  }
  if (path === "/levels" && request.method === "PUT") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { levels?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!Array.isArray(body.levels)) return json({ ok: false, error: "levels must be an array" }, 400);
    const levels = await saveLevels(env, body.levels);
    adminAuditEvent(env, ctx, { actorId: auth.userId, event: "levels_edited" });
    return json({ ok: true, levels });
  }

  // ── Approval queue ────────────────────────────────────────────────────────
  // The "owner of a level" is anyone who may read it: an admin, or a member
  // whose floor is at or above (as a number, at or below) the chunk's level.
  if (path === "/contributions" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const status = url.searchParams.get("status") ?? "pending";
    if (!["pending", "approved", "rejected"].includes(status)) return json({ ok: false, error: "status must be pending, approved or rejected" }, 400);
    const workspaces = readableWorkspaces(auth);
    const { results } = await env.DB.prepare(
      `SELECT id, submitter_id, source, source_path, content, suggested_level, confidence, top3, reason, status, final_level, created_at
       FROM contributions WHERE status = ? AND suggested_level >= ? AND workspace_id IN (${workspaces.map(() => "?").join(", ")})
       ORDER BY created_at DESC LIMIT 200`,
    ).bind(status, identityClearanceFloor(auth), ...workspaces).all();
    return json({ ok: true, contributions: (results ?? []).map((r: any) => ({ ...r, top3: safeJson(r.top3) })) });
  }

  // What the sender sees: status only, never the content or the level.
  if (path === "/contributions/mine" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const { results } = await env.DB.prepare(
      `SELECT id, source_path, status, created_at FROM contributions WHERE submitter_id = ? ORDER BY created_at DESC LIMIT 100`,
    ).bind(auth.userId).all();
    return json({ ok: true, contributions: results });
  }

  if (path === "/contributions/resolve" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; action?: string; level?: unknown; content?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.action !== "approve" && body.action !== "reject") return json({ ok: false, error: "action must be approve or reject" }, 400);
    const row = await env.DB.prepare(
      `SELECT id, workspace_id, submitter_id, doc_id, node_id, ord, source, source_path, content, suggested_level, confidence, top3, status FROM contributions WHERE id = ?`,
    ).bind(body.id.trim()).first<any>();
    const floor = identityClearanceFloor(auth);
    // A request the caller may not see answers exactly like one that does not exist.
    if (!row || row.suggested_level < floor || !readableWorkspaces(auth).includes(row.workspace_id)) return json({ ok: false, error: "Contribution not found" }, 404);
    if (row.status !== "pending") return json({ ok: false, error: `Already ${row.status}` }, 409);

    const now = Date.now();
    if (body.action === "reject") {
      await env.DB.prepare(`UPDATE contributions SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).bind(auth.userId, now, row.id).run();
      adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: row.submitter_id, workspaceId: row.workspace_id, event: "contribution_rejected", payload: { id: row.id } });
      return json({ ok: true, id: row.id, status: "rejected" });
    }

    const level = normalizeClearance(body.level, row.suggested_level);
    if (level === null) return json({ ok: false, error: `level must be an integer from 0 to ${CLEARANCE_MAX}` }, 400);
    if (level < floor) return json({ ok: false, error: `You may not publish at a level more restricted than P${floor}` }, 403);
    const content = typeof body.content === "string" && body.content.trim() ? body.content.trim() : row.content;
    const entryId = `bulk-${String(row.id).slice("contrib-".length)}`;
    await importExportPayload(env, {
      version: 2,
      entries: [{
        id: entryId, content, tags: ["bulk-ingest", `doc:${row.doc_id}`, "approved"],
        source: row.source || "bulk-ingest", clearance_level: level, source_path: row.source_path,
      }],
    }, { limit: 1, writeCtx: { workspaceId: row.workspace_id, actorId: row.submitter_id } });
    await env.DB.batch([
      env.DB.prepare(`UPDATE contributions SET status = 'approved', resolved_by = ?, resolved_at = ?, final_level = ?, entry_id = ? WHERE id = ? AND status = 'pending'`).bind(auth.userId, now, level, entryId, row.id),
      env.DB.prepare(`INSERT OR IGNORE INTO entry_classification (entry_id, doc_id, node_id, ord, jev_level, confidence, top3, review, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'approved', ?)`)
        .bind(entryId, row.doc_id, row.node_id, row.ord, row.suggested_level, row.confidence, row.top3, now),
    ]);
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: row.submitter_id, workspaceId: row.workspace_id, event: "contribution_approved", payload: { id: row.id, level, edited: content !== row.content } });
    return json({ ok: true, id: row.id, status: "approved", level, entry_id: entryId });
  }

  // Daily summary for the owner: the queue plus chunks the classifier was unsure about.
  if (path === "/contributions/digest" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const pending = await env.DB.prepare(`SELECT suggested_level AS level, COUNT(*) AS n FROM contributions WHERE status = 'pending' GROUP BY suggested_level ORDER BY suggested_level`).all();
    const low = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_classification WHERE review = 1`).first<{ n: number }>();
    return json({ ok: true, pending_by_level: pending.results, low_confidence_published: low?.n ?? 0 });
  }

  // ── PageIndex answer over one document ───────────────────────────────────
  if (path === "/pageindex/answer" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { query?: string; doc_id?: string; provider?: string; model?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.query?.trim() || !body.doc_id?.trim()) return json({ ok: false, error: "query and doc_id are required" }, 400);

    // The permission filter runs here, in SQL, before any model sees a word.
    const scope = scopeWhere(auth, undefined, "e.workspace_id");
    const { results } = await env.DB.prepare(
      `SELECT ec.node_id AS nodeId, ec.ord AS ord, e.id AS entryId, e.content AS content, e.clearance_level AS clearance,
              dn.title AS nodeTitle, dn.path AS nodePath, dn.parent_id AS parentId
       FROM entry_classification ec
       JOIN entries e ON e.id = ec.entry_id
       JOIN doc_nodes dn ON dn.doc_id = ec.doc_id AND dn.node_id = ec.node_id
       WHERE ec.doc_id = ? AND ${scope.clause}
       ORDER BY ec.ord`,
    ).bind(body.doc_id.trim(), ...scope.bindings).all<ReadableChunk>();
    const chunks = results ?? [];
    if (!chunks.length) return json({ ok: false, error: "Nothing readable in this document for your account" }, 404);

    const nodes = pruneTree(chunks);
    const cfg = await resolveConfig(env);
    const prefs = { provider: body.provider, model: body.model };
    let chosen: string[] = [];
    if (nodes.length > 1) {
      try {
        const text = await chatText(env, cfg, [{ role: "user", content: treePrompt(body.query, nodes) }], { ...prefs, maxTokens: 120, minClearance: Math.min(...chunks.map(c => c.clearance)) });
        chosen = parseNodeChoice(text, new Set(nodes.map(n => n.id)));
      } catch { /* fall back to the first nodes below */ }
    }
    if (!chosen.length) chosen = nodes.slice(0, 3).map(n => n.id);
    const { context, ids } = answerContext(nodes, chosen);
    const picked = chunks.filter(c => ids.includes(c.entryId));
    let result;
    try {
      result = await chat(env, cfg, [
        { role: "system", content: ANSWER_SYSTEM },
        { role: "user", content: `Question: ${body.query}\n\nSections:\n${context}` },
      ], { ...prefs, minClearance: picked.length ? Math.min(...picked.map(c => c.clearance)) : undefined });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "LLM unavailable" }, 502);
    }
    return new Response(streamWithMeta(result, { node_ids: chosen }), {
      headers: { "Content-Type": "text/event-stream", "X-LLM-Provider": result.provider, "X-LLM-Model": result.model, ...CORS_HEADERS },
    });
  }

  return null;
}

function safeJson(v: unknown): unknown {
  try { return JSON.parse(String(v)); } catch { return []; }
}
