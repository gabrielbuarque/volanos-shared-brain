import type { Env } from "../env";
import { resolveConfig } from "../config";
import { adminAuditEvent } from "../lib/admin-audit";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { INTERNAL_CLIENT, clientPredicate, isStaleSource, parseClientParam, reviewStateOf } from "../lib/clients";
import { intParam, json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { identityClearanceFloor } from "../lib/permissions";
import { layerOf, readableWorkspaces } from "../lib/scope";
import { applyDocumentEdit } from "../memory/apply-edit";
import { hydrateScopedEntries, selectScopedEntries } from "../lib/scoped-entries";

/**
 * Rotas dos clientes: página do cliente (Canon e fontes), conflito sinalizado, proposta de Canon.
 * Tudo que devolve conteúdo passa por scopedEntriesQuery: nível, workspace e ACL no SQL.
 */

interface ClientHead { id: string; name: string; owner: { id: string; name: string } | null }

/** Cabeçalho do cliente, só se ele existir num workspace legível. O interno não é diretório. */
export async function clientHead(env: Env, identity: { role: string; personalWorkspaceId: string; companyWorkspaceIds: string[] }, id: string): Promise<ClientHead | null> {
  if (id === INTERNAL_CLIENT) return { id, name: "", owner: null };
  const workspaces = readableWorkspaces(identity as never);
  const row = await env.DB.prepare(
    `SELECT d.id, d.name, d.owner_id, u.name AS owner_name FROM brain_directories d LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id = ? AND d.workspace_id IN (${workspaces.map(() => "?").join(", ")})`,
  ).bind(id, ...workspaces).first<{ id: string; name: string; owner_id: string; owner_name: string | null }>();
  return row ? { id: row.id, name: row.name, owner: row.owner_id ? { id: row.owner_id, name: row.owner_name ?? "" } : null } : null;
}

/** Dono do cliente a que uma contribuição se refere (doc_id = "client:<id>"), se houver. */
export async function ownsClientOf(env: Env, userId: string, docId: string): Promise<boolean> {
  if (!docId.startsWith("client:")) return false;
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM brain_directories WHERE id = ? AND owner_id = ?`).bind(docId.slice("client:".length), userId).first();
  return !!row;
}

export async function handleClientRoutes(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const path = url.pathname;

  // GET /client/entries?client=<id|internal>&view=canon|sources&level=&n=
  if (path === "/client/entries" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const clientId = parseClientParam(url.searchParams.get("client"));
    if (!clientId) return json({ ok: false, error: "client is required" }, 400);
    const view = url.searchParams.get("view") === "canon" ? "canon" : "sources";
    const n = intParam(url, "n", { fallback: 50, min: 1, max: 200 });
    if (n instanceof Response) return n;
    const level = intParam(url, "level", { min: 0, max: 12 });
    if (level instanceof Response) return level;
    const head = await clientHead(env, auth, clientId);
    // Cliente inexistente e cliente ilegível respondem igual: 404.
    if (!head) return json({ ok: false, error: "Client not found" }, 404);
    const client = clientPredicate(clientId);
    const where = [client.clause, "tags NOT LIKE '%\"status:deprecated\"%'", view === "canon" ? "tags LIKE '%\"status:canonical\"%'" : "tags NOT LIKE '%\"status:canonical\"%'", level !== undefined ? "clearance_level = ?" : ""].filter(Boolean).join(" AND ");
    const rows = await selectScopedEntries<Record<string, any>>(env, auth, {
      select: `id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated, actor_id, clearance_level, workspace_id`,
      where, bindings: [...client.bindings, ...(level !== undefined ? [level] : [])],
      orderBy: `COALESCE(updated_at, created_at) DESC`, limit: n,
    });
    const cfg = await resolveConfig(env);
    const labels = await lookupActorLabels(env, rows.map((r) => String(r.actor_id ?? "")));
    return json({
      ok: true, client: head, view,
      entries: rows.map((r) => {
        const tags = safeTags(r.tags);
        return {
          id: r.id, content: r.content, tags, source: r.source, created_at: r.created_at, updated_at: r.last_updated,
          clearance_level: r.clearance_level, client_id: clientId === INTERNAL_CLIENT ? null : clientId,
          author: resolveActorLabel(String(r.actor_id ?? ""), labels, { viewerId: auth.userId, source: String(r.source ?? "") }),
          review_state: reviewStateOf(tags), stale: isStaleSource(Number(r.last_updated), cfg.AGING_COLD_DAYS),
        };
      }),
    });
  }

  // POST /conflicts/flag { a, b }: "Sinalizar para quem decide". Cria ou reabre o alerta de contradição.
  if (path === "/conflicts/flag" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { a?: unknown; b?: unknown; metric?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const a = typeof body.a === "string" ? body.a : "";
    const b = typeof body.b === "string" ? body.b : "";
    if (!a || !b || a === b) return json({ ok: false, error: "a and b are required" }, 400);
    // As duas precisam ser legíveis por quem sinaliza. Ilegível responde como inexistente.
    const rows = await hydrateScopedEntries<{ id: string; tags: string; actor_id: string; workspace_id: string; created_at: number; last_updated: number | null }>(env, auth, [a, b], `id, tags, actor_id, workspace_id, created_at, COALESCE(updated_at, created_at) AS last_updated`);
    if (rows.length !== 2) return json({ ok: false, error: "Source not found" }, 404);
    const canonical = rows.find((r) => safeTags(r.tags).includes("status:canonical"));
    const newest = [...rows].sort((x, y) => Number(y.last_updated ?? y.created_at) - Number(x.last_updated ?? x.created_at))[0];
    const decider = canonical ?? newest;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const detail = JSON.stringify({ flagged_by: auth.userId, metric: typeof body.metric === "string" ? body.metric.slice(0, 300) : "" });
    await env.DB.prepare(
      `INSERT INTO aging_suggestions (id, kind, workspace_id, a_id, b_id, score, detail, owner_id, status, created_at)
       VALUES (?, 'contradiction', ?, ?, ?, 1, ?, ?, 'open', ?)
       ON CONFLICT(kind, a_id, b_id) DO UPDATE SET status = 'open', detail = excluded.detail`,
    ).bind(crypto.randomUUID(), decider.workspace_id, lo, hi, detail, decider.actor_id ?? "", Date.now()).run();
    const labels = await lookupActorLabels(env, [String(decider.actor_id ?? "")]);
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: decider.workspace_id, event: "conflict_flagged", payload: { a: lo, b: hi } });
    return json({ ok: true, owner: decider.actor_id ? { id: decider.actor_id, name: labels.get(String(decider.actor_id)) ?? "" } : null });
  }

  // POST /canon/propose { content, client, source_ids }: o texto vai para a fila de revisão.
  // O nível sugerido é o mais restrito entre as fontes usadas: um resumo nunca é mais aberto que a fonte.
  if (path === "/canon/propose" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { content?: unknown; client?: unknown; source_ids?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 20000) return json({ ok: false, error: "content is required (up to 20000 characters)" }, 400);
    const clientId = typeof body.client === "string" ? parseClientParam(body.client) : undefined;
    if (!clientId) return json({ ok: false, error: "client is required" }, 400);
    const head = await clientHead(env, auth, clientId);
    if (!head) return json({ ok: false, error: "Client not found" }, 404);
    const ids = Array.isArray(body.source_ids) ? [...new Set(body.source_ids.filter((x): x is string => typeof x === "string"))].slice(0, 50) : [];
    const sources = ids.length ? await hydrateScopedEntries<{ clearance_level: number }>(env, auth, ids, "clearance_level") : [];
    const floor = identityClearanceFloor(auth);
    const level = sources.length ? Math.min(...sources.map((s) => Number(s.clearance_level))) : floor;
    const id = `contrib-canon-${crypto.randomUUID()}`;
    const workspace = auth.companyWorkspaceIds[0] ?? auth.personalWorkspaceId;
    await env.DB.prepare(
      `INSERT INTO contributions (id, workspace_id, submitter_id, doc_id, node_id, ord, source, source_path, content, suggested_level, confidence, top3, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'canon', 0, 'canon', NULL, ?, ?, NULL, '[]', 'canon-proposal', 'pending', ?)`,
    ).bind(id, workspace, auth.userId, `client:${clientId}`, content, level, Date.now()).run();
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: workspace, event: "canon_proposed", payload: { id, client: clientId, level } });
    return json({ ok: true, id, level, owner: head.owner });
  }

  // POST /entry/propose-edit { id, content }: quem lê um documento pode propor um texto novo para ele.
  // Admin e quem tem publicação direta aplicam na hora (com versão); os demais entram na fila do owner do cliente,
  // que vê o que mudou antes de aprovar. Só documentos do Shared Brain: nota privada é de quem a escreveu.
  if (path === "/entry/propose-edit" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; content?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const entryId = typeof body.id === "string" ? body.id.trim() : "";
    const content = typeof body.content === "string" ? body.content.replace(/\r\n/g, "\n").trim() : "";
    if (!entryId) return json({ ok: false, error: "id is required" }, 400);
    if (!content || content.length > 20000) return json({ ok: false, error: "content is required (up to 20000 characters)" }, 400);
    const row = (await selectScopedEntries<{ id: string; content: string; workspace_id: string; clearance_level: number; directory_id: string | null }>(
      env, auth, { select: "id, content, workspace_id, clearance_level, directory_id", where: "id = ?", bindings: [entryId], limit: 1 },
    ))[0];
    if (!row) return json({ ok: false, error: `No entry found with ID: ${entryId}` }, 404);
    if (layerOf(auth, row.workspace_id) !== "company") return json({ ok: false, error: "Only shared documents take edit proposals" }, 400);
    if (row.content.trim() === content) return json({ ok: false, error: "No change" }, 400);

    // scope-exempt: reads the caller's own row for a flag; no content
    const flag = await env.DB.prepare(`SELECT direct_publish AS d FROM users WHERE id = ?`).bind(auth.userId).first<{ d: number }>();
    if (auth.role === "admin" || flag?.d === 1) {
      await applyDocumentEdit(env, row.id, content, auth.userId);
      adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: row.workspace_id, event: "document_edited", payload: { id: row.id } });
      return json({ ok: true, applied: true });
    }
    const head = row.directory_id ? await clientHead(env, auth, row.directory_id) : null;
    const proposalId = `contrib-edit-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO contributions (id, workspace_id, submitter_id, doc_id, node_id, ord, source, source_path, content, suggested_level, confidence, top3, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'edit', NULL, ?, ?, NULL, '[]', 'edit-proposal', 'pending', ?)`,
    ).bind(proposalId, row.workspace_id, auth.userId, `client:${row.directory_id ?? INTERNAL_CLIENT}`, `edit:${row.id}`, content, Number(row.clearance_level), Date.now()).run();
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: row.workspace_id, event: "edit_proposed", payload: { id: proposalId, entry: row.id } });
    return json({ ok: true, applied: false, id: proposalId, owner: head ? head.owner : null });
  }

  // POST /admin/view-as/start { id }: só registra a decisão de ver como outra pessoa (a visão em si é o header X-View-As).
  if (path === "/admin/view-as/start" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const target = typeof body.id === "string" ? body.id : "";
    // scope-exempt: reads the target's own users row (name, level) for the banner; no memory content
    const row = target ? await env.DB.prepare(`SELECT id, name, clearance_floor FROM users WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`).bind(target).first<{ id: string; name: string; clearance_floor: number }>() : null;
    if (!row) return json({ ok: false, error: "Person not found" }, 404);
    adminAuditEvent(env, ctx, { actorId: auth.userId, targetUserId: row.id, event: "view_as_started", payload: {} });
    return json({ ok: true, person: { id: row.id, name: row.name, clearanceFloor: row.clearance_floor } });
  }

  return null;
}

function safeTags(raw: unknown): string[] {
  try { const v = JSON.parse(String(raw ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
