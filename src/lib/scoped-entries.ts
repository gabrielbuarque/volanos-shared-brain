import type { Env } from "../env";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import type { Identity } from "./identity";
import { scopeWhereForRead } from "./scope";

/**
 * The single door for READING `entries` on behalf of a caller.
 *
 * The workspace + clearance + directory-ACL predicate is spliced into the WHERE
 * clause here, so it always lands before ORDER BY and LIMIT: the window ranks
 * and cuts readable rows only, never "readable plus forbidden, truncated, then
 * filtered". New read paths in src/recall, src/routes and src/mcp go through
 * scopedEntriesQuery(); test/unit/permission-audit.test.ts fails the build when
 * one writes `FROM entries` / `JOIN entries` without it (or without an
 * annotated exemption).
 *
 * Admins get no clearance predicate (see entryPermissionClause) but keep the
 * workspace one, exactly as before.
 */

export interface ScopedEntriesSpec {
  /** Column list. May reference `alias.` columns when `alias` is set. */
  select: string;
  /** Extra predicate, ANDed with the scope. Do not put ORDER BY / LIMIT here. */
  where?: string;
  /** Bindings for `where`, in order. */
  bindings?: readonly (string | number)[];
  /** Column list for GROUP BY, after the scoped WHERE and before ORDER BY. Aggregates see readable rows only. */
  groupBy?: string;
  /** Appended after the scoped WHERE. Plain expression list, no keyword. */
  orderBy?: string;
  limit?: number;
  offset?: number;
  /** Table alias; the scope clause is qualified with it. */
  alias?: string;
  /** Narrow the layer / team exactly as the read routes do. */
  layer?: "personal" | "company";
  teamId?: string;
}

export interface BuiltQuery {
  sql: string;
  bindings: (string | number)[];
}

export function scopedEntriesQuery(identity: Identity, spec: ScopedEntriesSpec): BuiltQuery {
  const alias = spec.alias ?? "";
  const scope = scopeWhereForRead(
    identity,
    { layer: spec.layer, teamId: spec.teamId },
    alias ? `${alias}.workspace_id` : "workspace_id",
  );
  const bindings: (string | number)[] = [...(spec.bindings ?? []), ...scope.bindings];
  let sql = `SELECT ${spec.select} FROM entries${alias ? ` ${alias}` : ""} WHERE ${spec.where ? `(${spec.where}) AND ` : ""}${scope.clause}`;
  if (spec.groupBy) sql += ` GROUP BY ${spec.groupBy}`;
  if (spec.orderBy) sql += ` ORDER BY ${spec.orderBy}`;
  if (spec.limit !== undefined) {
    sql += ` LIMIT ?`;
    bindings.push(spec.limit);
    if (spec.offset !== undefined) {
      sql += ` OFFSET ?`;
      bindings.push(spec.offset);
    }
  }
  return { sql, bindings };
}

export async function selectScopedEntries<T = Record<string, unknown>>(
  env: Env,
  identity: Identity,
  spec: ScopedEntriesSpec,
): Promise<T[]> {
  const q = scopedEntriesQuery(identity, spec);
  const { results } = await env.DB.prepare(q.sql).bind(...q.bindings).all();
  return (results ?? []) as T[];
}

/**
 * By-id hydration for ids that came from somewhere untrusted (a Vectorize hit,
 * a client-supplied list). Ids the caller may not read simply do not come back.
 * Chunked under D1's bound-parameter ceiling, the scope's bindings included.
 */
export async function hydrateScopedEntries<T = Record<string, unknown>>(
  env: Env,
  identity: Identity,
  ids: readonly string[],
  select: string,
  opts: { layer?: "personal" | "company"; teamId?: string; where?: string; bindings?: readonly (string | number)[]; } = {},
): Promise<T[]> {
  const out: T[] = [];
  const extra = opts.bindings ?? [];
  const probe = scopedEntriesQuery(identity, { select, where: "id IN ()", layer: opts.layer, teamId: opts.teamId });
  const room = D1_MAX_BOUND_PARAMS - probe.bindings.length - extra.length;
  const batchSize = Math.max(1, room);
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const where = `id IN (${batch.map(() => "?").join(", ")})${opts.where ? ` AND ${opts.where}` : ""}`;
    out.push(...await selectScopedEntries<T>(env, identity, {
      select, where, bindings: [...batch, ...extra], layer: opts.layer, teamId: opts.teamId,
    }));
  }
  return out;
}
