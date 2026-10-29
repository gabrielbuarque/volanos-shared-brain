import type { Env } from "../env";
import { resolveConfig } from "../config";
import { getLevels, RUBRIC_RULES } from "../ingest/levels";
import { adminAuditEvent } from "../lib/admin-audit";
import { INTERNAL_CLIENT, listAccessibleClients, parseClientParam } from "../lib/clients";
import { intParam, json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { identityClearanceFloor } from "../lib/permissions";
import { chatText } from "../llm/provider";
import { clientHead } from "./clients";

/**
 * Contribuir e auditoria de permissões.
 *
 * - /contributions/suggest: a IA sugere cliente, nível P e resumo. Só sugere: a pessoa confirma ou corrige.
 * - /contributions/submit: o item entra na fila do owner do cliente (revisão em /contributions).
 * - /admin/audit: trilha administrativa com nomes, filtrada por eventos de permissão.
 */

/** Eventos que dizem quem pode ver o quê: acesso, nível, convite, diretório, aprovação e "ver como". */
export const PERMISSION_EVENTS = [
  "member_created", "member_removed", "member_suspended", "member_unsuspended", "member_clearance_set", "member_direct_publish_set",
  "member_invited", "member_invite_cancelled", "member_joined", "member_approved", "directory_created", "directory_grant_set",
  "levels_edited", "contribution_approved", "contribution_rejected", "view_as_started",
];

function safeObject(raw: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function plain(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface Suggestion { client: string; level: number; summary: string }

/** Sugestão sem modelo: o cliente mais citado no nome do arquivo e no texto; nível = o piso de quem envia. */
export function suggestByRules(content: string, filename: string, clients: { id: string; name: string }[], floor: number): Suggestion {
  const hay = plain(`${filename}\n${content}`);
  let best: { id: string; n: number } | null = null;
  for (const c of clients) {
    const needle = plain(c.name);
    if (!needle) continue;
    const n = hay.split(needle).length - 1;
    if (n > 0 && (!best || n > best.n)) best = { id: c.id, n };
  }
  const first = content.replace(/^#+\s*/gm, "").split(/(?<=[.!?])\s|\n/).map((x) => x.trim()).find((x) => x.length > 8) ?? content.slice(0, 120);
  return { client: best?.id ?? INTERNAL_CLIENT, level: Math.max(0, Math.min(12, floor)), summary: first.slice(0, 200) };
}

/** Lê o JSON da resposta do modelo. Cliente que não bate com a lista vira interno; nível fora de 0 a 12 invalida. */
export function parseSuggestion(raw: string, clients: { id: string; name: string }[]): Suggestion | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { client?: unknown; level?: unknown; summary?: unknown };
    const level = Number(o.level);
    if (!Number.isInteger(level) || level < 0 || level > 12) return null;
    const name = typeof o.client === "string" ? plain(o.client.trim()) : "";
    const found = clients.find((c) => plain(c.name) === name);
    return { client: found ? found.id : INTERNAL_CLIENT, level, summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 300) : "" };
  } catch {
    return null;
  }
}

export async function handleContributeRoutes(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/contributions/suggest" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { content?: unknown; filename?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return json({ ok: false, error: "content is required" }, 400);
    const filename = typeof body.filename === "string" ? body.filename.slice(0, 200) : "";
    const { clients } = await listAccessibleClients(env, auth);
    const floor = identityClearanceFloor(auth);
    let suggestion: Suggestion & { source: "rules" | "ai" } = { ...suggestByRules(content, filename, clients, floor), source: "rules" };
    try {
      // O texto vai a um modelo SEM nível conhecido: só a cadeia restrita (Workers AI, por padrão) o recebe.
      const cfg = await resolveConfig(env);
      const levels = await getLevels(env);
      const prompt = [
        'Classify a document for Volanos. Reply with ONE JSON object and nothing else: {"client": "<exact client name or internal>", "level": <0-12>, "summary": "<one sentence, max 200 characters, same language as the document>"}.',
        `Clients: ${clients.map((c) => c.name).join(", ") || "(none)"}. Use "internal" when it is not about one of them.`,
        "Levels (P0 most restricted, P12 public):",
        ...levels.map((l) => `P${l.level}: ${l.holders}. ${l.reads}`),
        "Rules:",
        ...RUBRIC_RULES.map((r) => `- ${r}`),
        `Document${filename ? ` (${filename})` : ""}:`,
        content.slice(0, 6000),
      ].join("\n");
      const raw = await chatText(env, cfg, [{ role: "user", content: prompt }], { maxTokens: 300 });
      const parsed = parseSuggestion(raw, clients);
      if (parsed) suggestion = { ...parsed, source: "ai" };
    } catch { /* sem modelo: ficam as regras */ }
    return json({ ok: true, ...suggestion, floor });
  }

  if (path === "/contributions/submit" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { content?: unknown; filename?: unknown; client?: unknown; level?: unknown; summary?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 60000) return json({ ok: false, error: "content is required (up to 60000 characters)" }, 400);
    const clientId = typeof body.client === "string" ? parseClientParam(body.client) : undefined;
    if (!clientId) return json({ ok: false, error: "client is required" }, 400);
    const head = await clientHead(env, auth, clientId);
    if (!head) return json({ ok: false, error: "Client not found" }, 404);
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 0 || level > 12) return json({ ok: false, error: "level must be an integer from 0 to 12" }, 400);
    const id = `contrib-ui-${crypto.randomUUID()}`;
    const workspace = auth.companyWorkspaceIds[0] ?? auth.personalWorkspaceId;
    const filename = typeof body.filename === "string" ? body.filename.slice(0, 200) : null;
    const hint = typeof body.summary === "string" && body.summary.trim() ? [{ summary: body.summary.trim().slice(0, 300) }] : [];
    await env.DB.prepare(
      `INSERT INTO contributions (id, workspace_id, submitter_id, doc_id, node_id, ord, source, source_path, content, suggested_level, confidence, top3, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'contribution', 0, 'upload', ?, ?, ?, NULL, ?, 'client-contribution', 'pending', ?)`,
    ).bind(id, workspace, auth.userId, `client:${clientId}`, filename, content, level, JSON.stringify(hint), Date.now()).run();
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: workspace, event: "contribution_submitted", payload: { id, client: clientId, level } });
    return json({ ok: true, id, owner: head.owner });
  }

  if (path === "/admin/audit" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const n = intParam(url, "n", { fallback: 50, min: 1, max: 200 });
    if (n instanceof Response) return n;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const permissionsOnly = url.searchParams.get("group") !== "all";
    const marks = PERMISSION_EVENTS.map(() => "?").join(", ");
    // scope-exempt: admin trail; rows carry ids, names and small payloads, never memory content
    const { results } = await env.DB.prepare(
      `SELECT ae.id, ae.event, ae.payload, ae.created_at, ae.actor_id, ae.target_user_id,
              (SELECT name FROM users WHERE users.id = ae.actor_id) AS actor_name,
              (SELECT name FROM users WHERE users.id = ae.target_user_id) AS target_name
       FROM admin_events ae WHERE 1 = 1 ${permissionsOnly ? `AND ae.event IN (${marks})` : ""} ${before !== undefined ? "AND ae.created_at < ?" : ""}
       ORDER BY ae.created_at DESC LIMIT ?`,
    ).bind(...(permissionsOnly ? PERMISSION_EVENTS : []), ...(before !== undefined ? [before] : []), n + 1).all<Record<string, any>>();
    const rows = results ?? [];
    return json({
      ok: true,
      more: rows.length > n,
      events: rows.slice(0, n).map((r) => ({ id: r.id, event: r.event, created_at: r.created_at, actor: r.actor_name ?? "", target: r.target_name ?? "", payload: safeObject(r.payload) })),
    });
  }

  return null;
}
