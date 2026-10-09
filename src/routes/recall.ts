import type { Env } from "../env";
import { resolveConfig } from "../config";
import { LLM_MODEL, VECTORIZE_FIX_HINT } from "../constants";
import { chat, listModels, streamWithMeta } from "../llm/provider";
import { buildEntryFilterQuery } from "../capture/entry";
import { compressTag } from "../compression/digest";
import { CORS_HEADERS, intParam, json, readWorkspaceParam, readTeamQueryParam } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { assertCanMutateEntry } from "../lib/entry-access";
import { readerOf } from "../lib/permissions";
import { layerOf, scopeWhereForRead, readScopeWorkspaces } from "../lib/scope";
import { hydrateScopedEntries } from "../lib/scoped-entries";
import { recordAccessAfterResponse } from "../memory/usage";
import { lookupActorLabels, resolveActorFilter, resolveActorLabel } from "../lib/actors";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { recallEntries } from "../recall/search";
import type { RerankInfo } from "../recall/reranker";
import { allowanceFor, snippetOf } from "../recall/snippet";
import { findSourceConflicts, isStaleSource, listAccessibleClients, parseClientParam, reviewStateOf } from "../lib/clients";
import { ANSWER_PROMPT } from "../recall/answer-prompt";

/**
 * What /recall says about the reranker: whether it reordered this answer, and how
 * long it took. `reranker` is null when no mode is configured.
 */
function rerankFields(rerank: RerankInfo | undefined) {
  return {
    reranked: rerank?.ran ?? false,
    reranker: rerank ? { mode: rerank.mode, ms: rerank.ms, candidates: rerank.candidates, degraded: rerank.degraded ?? null } : null,
  };
}

/** Add the caller's workspace predicate before ORDER BY and LIMIT. */
function scopeEntryFilterQuery(
  identity: Identity,
  q: { sql: string; bindings: unknown[] },
  layer?: "personal" | "company",
  teamId?: string,
): { sql: string; bindings: unknown[] } {
  const scope = scopeWhereForRead(identity, { layer, teamId });
  const sql = q.sql.includes("WHERE")
    ? q.sql.replace(" ORDER BY", ` AND ${scope.clause} ORDER BY`)
    : q.sql.replace(" ORDER BY", ` WHERE ${scope.clause} ORDER BY`);
  return { sql, bindings: [...q.bindings.slice(0, -1), ...scope.bindings, ...q.bindings.slice(-1)] };
}

export async function handleRecallRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /list
  if (url.pathname === "/list" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;
    // Floor of 0 as well as the cap: SQLite reads a negative LIMIT as no limit
    // at all, so `?n=-1` used to return the whole entries table.
    const n = intParam(url, "n", { fallback: 20, min: 0, max: 100 });
    if (n instanceof Response) return n;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;
    const team = readTeamQueryParam(url, identity, workspace);
    if (team instanceof Response) return team;
    // Who wrote it, as a filter. Resolved here rather than in the builder
    // because resolution needs the caller's identity: the value that reaches
    // SQL is always a user id from the caller's own roster, so `?actor=` can
    // narrow the scoped listing and can never reach outside it.
    const actorParam = url.searchParams.get("actor")?.trim();
    let actor: string | undefined;
    if (actorParam) {
      const resolved = await resolveActorFilter(env, identity, actorParam);
      if (!resolved.ok) return json({ ok: false, error: resolved.error }, 400);
      actor = resolved.actorId;
    }

    const { sql, bindings } = scopeEntryFilterQuery(identity, buildEntryFilterQuery({ n, tag, after, before, actor }), workspace, team);
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    const rows = results as Record<string, unknown>[];
    // Each row reports its layer so the dashboard can badge cards and offer
    // share/unshare without knowing the caller's workspace ids itself.
    const companyRows = rows.filter((r) => layerOf(identity, r.workspace_id) === "company");
    const labelMap = await lookupActorLabels(
      env,
      companyRows.map((r) => String(r.actor_id ?? "")),
    );
    return json(rows.map((r) => {
      const layer = layerOf(identity, r.workspace_id);
      // actor_name is always present, null where there is no author to name —
      // the same contract GET /recall's results carry. It used to be added only
      // on company rows, which made the KEY's existence depend on whether the
      // page happened to contain a shared memory: on a personal brain it never
      // appeared at all, so a client could not tell "nobody wrote this" from
      // "this deployment does not report authors".
      return {
        ...r,
        workspace: layer,
        // The same answer GET /entry gives, from the same predicate the mutation
        // routes enforce with: a card the caller cannot edit says so before they
        // try. Computed for every row, not only company ones, so a client can
        // read a missing field as "old Worker" and a present `true` as a real
        // answer. workspace_id and actor_id are already in the projection —
        // layerOf reads the first and lookupActorLabels the second — so this
        // costs no query.
        can_edit: assertCanMutateEntry(identity, {
          workspace_id: String(r.workspace_id ?? ""),
          actor_id: String(r.actor_id ?? ""),
        }) === null,
        actor_name: layer === "company"
          ? resolveActorLabel(String(r.actor_id ?? ""), labelMap, {
              viewerId: identity.userId,
              source: String(r.source ?? ""),
            })
          : null,
      };
    }));
  }

  // GET /recall — semantic search, mirrors the MCP `recall` tool
  if (url.pathname === "/recall" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    const query = url.searchParams.get("query")?.trim();
    if (!query) return json({ ok: false, error: "query is required" }, 400);

    const topK = intParam(url, "topK", { fallback: 5, min: 1, max: 20 });
    if (topK instanceof Response) return topK;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const kindParam = url.searchParams.get("kind")?.trim();
    const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;
    const hops = intParam(url, "hops", { fallback: 0, min: 0, max: 3 });
    if (hops instanceof Response) return hops;
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;
    const team = readTeamQueryParam(url, identity, workspace);
    if (team instanceof Response) return team;
    // Long memories are shortened by default so API/CLI consumers get a bounded
    // payload. Renderers that show the whole memory (the dashboard) pass full=1.
    const full = ["1", "true", "yes"].includes((url.searchParams.get("full") ?? "").toLowerCase());
    // Client scope: narrows on top of level, workspace and directory ACL, never replaces them.
    const clientId = parseClientParam(url.searchParams.get("client"));

    const cfg = await resolveConfig(env);
    const { matches, insight, semanticUnavailable, queryUsed, queryTokens, compoundStale, rerank } = await recallEntries({ query, topK, tag, after, before, kind, hops }, env, ctx, cfg, { identity, workspaceFilter: workspace, teamId: team, clientId });

    if (!matches.length) {
      return json({
        ok: true,
        results: [],
        client: clientId ?? null,
        conflicts: [],
        ...rerankFields(rerank),
        query_used: queryUsed,
        semantic_unavailable: semanticUnavailable,
        message: semanticUnavailable
          ? `Semantic search unavailable (Vectorize index missing). Fix: ${VECTORIZE_FIX_HINT}.`
          : "Nothing found matching that query.",
      });
    }

    const conflicts = await findSourceConflicts(env, matches.map((m) => ({ id: m.id, content: m.content })));
    return json({
      ok: true,
      query_used: queryUsed,
      client: clientId ?? null,
      conflicts,
      ...rerankFields(rerank),
      compound_stale: compoundStale ?? null,
      results: matches.map((m, i) => {
        const s = full
          ? { text: m.content, truncated: false, fullLength: (m.content ?? "").length }
          : snippetOf(m.content, allowanceFor(i, m.score, cfg), { queryTokens });
        return {
          id: m.id,
          content: s.text,
          truncated: s.truncated,
          full_length: s.fullLength,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
          stale_as_of: m.staleAsOf,
          updated: m.isUpdate,
          hop: m.hop,
          workspace: m.workspace ?? null,
          clearance_level: m.clearance ?? null,
          actor_name: m.workspace === "company" ? (m.actorName ?? null) : null,
          author: m.workspace === "company" ? (m.actorName ?? null) : null,
          client_id: m.directoryId ?? null,
          review_state: reviewStateOf(m.tags),
          stale: isStaleSource(m.updatedAt, cfg.AGING_COLD_DAYS, Date.now(), m.staleAsOf),
          via_provenance: m.viaProvenance ?? null,
          via_type: m.viaType ?? null,
          linked_at: m.viaLinkedAt ?? null,
          related_to: m.viaFrom ?? null,
        };
      }),
      insight: insight || null,
      semantic_unavailable: semanticUnavailable,
    });
  }

  // POST /chat
  if (url.pathname === "/chat" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { query?: string; memories?: string; memory_ids?: unknown; provider?: string; model?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

    // The memories arrive numbered, dated and attributed (see the client's
    // serializer in public/js/recall.js and the MCP tool's mirror of it), so
    // the model has everything it needs to be specific — it just has to be
    // asked. The previous prompt ended "Be concise", and on a brain holding
    // three days of dense decisions "What did I decide recently?" came back as
    // one sentence about an unrelated email: the top match, summarised, with
    // the other four sources ignored.
    const systemPrompt = ANSWER_PROMPT;

    const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;
    const cfg = await resolveConfig(env);

    // The most restricted memory in the context decides which providers may see
    // it (src/llm/provider.ts). Without memory_ids the level is unknown, and an
    // unknown level is treated as restricted.
    const ids = Array.isArray(body.memory_ids) ? [...new Set(body.memory_ids.filter((x): x is string => typeof x === "string"))].slice(0, 50) : [];
    let minClearance: number | undefined;
    if (ids.length) {
      // Scoped: an id the caller cannot read does not come back, the count falls
      // short, and the level stays unknown (= restricted). It also stops this route
      // from being a probe for the level of an arbitrary memory id.
      const rows = await hydrateScopedEntries<{ id: string; clearance_level: number }>(env, auth, ids, "id, clearance_level");
      // The memories this answer cites are being used: count them (readable ids only).
      recordAccessAfterResponse(env, ctx, rows.map(r => r.id));
      const row = rows.length ? { n: rows.length, m: Math.min(...rows.map(r => Number(r.clearance_level))) } : null;
      if (row && Number(row.n) === ids.length && row.m !== null) minClearance = Number(row.m);
    }

    let result;
    try {
      result = await chat(env, cfg, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ], { provider: body.provider, model: body.model, minClearance });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "LLM unavailable" }, 502);
    }

    return new Response(streamWithMeta(result), {
      headers: { "Content-Type": "text/event-stream", "X-LLM-Provider": result.provider, "X-LLM-Model": result.model, ...CORS_HEADERS },
    });
  }

  // GET /clients — only the clients this person can read something in (names included).
  if (url.pathname === "/clients" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, ...(await listAccessibleClients(env, auth)) });
  }

  // GET /llm/models — picker contents: only providers with a configured secret.
  if (url.pathname === "/llm/models" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const cfg = await resolveConfig(env);
    const models = await listModels(env, cfg);
    return json({ ok: true, models, default: { provider: cfg.LLM_DEFAULT_PROVIDER, model: cfg.LLM_DEFAULT_MODEL } });
  }

  // GET /digest
  if (url.pathname === "/digest" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;
    const tag = url.searchParams.get("tag")?.trim();
    if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);
    const workspaceFilter = readWorkspaceParam(url);
    if (workspaceFilter instanceof Response) return workspaceFilter;
    const team = readTeamQueryParam(url, identity, workspaceFilter);
    if (team instanceof Response) return team;

    const result = await compressTag(tag, env, ctx, {
      workspaceIds: readScopeWorkspaces(identity, { layer: workspaceFilter, teamId: team }),
      reader: readerOf(identity),
    });

    if (!result.synthesizedId) {
      return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
    }

    return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
  }

  return null;
}
