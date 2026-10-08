import type { Env } from "../env";
import type { Identity } from "./identity";

/**
 * Volanos clearance levels. P0 is the most restricted level (leadership only)
 * and P12 is the broadest level (safe for the whole company). A member's
 * clearanceFloor is the lowest restriction they may read: a P4 member can read
 * P4..P12, while an administrator can read every level.
 */
export const CLEARANCE_MIN = 0;
export const CLEARANCE_MAX = 12;
export const DEFAULT_CLEARANCE = 12;

export type PermissionResult =
  | { ok: true; clearanceLevel: number; directoryId: string | null; sourcePath: string | null }
  | { ok: false; status: 400 | 403 | 404; error: string };

export function normalizeClearance(value: unknown, fallback = DEFAULT_CLEARANCE): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < CLEARANCE_MIN || n > CLEARANCE_MAX) return null;
  return n;
}

export function identityClearanceFloor(identity: Identity): number {
  return identity.role === "admin" ? CLEARANCE_MIN : Math.max(CLEARANCE_MIN, Math.min(CLEARANCE_MAX, identity.clearanceFloor ?? DEFAULT_CLEARANCE));
}

export function canReadClearance(identity: Identity, level: unknown): boolean {
  const clearance = normalizeClearance(level);
  return clearance !== null && (identity.role === "admin" || clearance >= identityClearanceFloor(identity));
}

/**
 * What the permission predicate needs to know about whoever is reading. A plain
 * value so that write paths (which carry a WriteContext, not an Identity) can
 * apply the very same predicate when they look at existing rows.
 */
export interface Reader {
  userId: string;
  admin: boolean;
  /** Lowest level (most restricted) this reader may read. Ignored for admins. */
  floor: number;
}

export function readerOf(identity: Identity): Reader {
  return { userId: identity.userId, admin: identity.role === "admin", floor: identityClearanceFloor(identity) };
}

/** SQL predicate for an entries row. It is intentionally used by scope.ts so
 * every route that already applies workspace scope also applies permissions. */
export function entryPermissionClause(identity: Identity, alias = ""): { clause: string; bindings: (string | number)[] } {
  return readerPermissionClause(readerOf(identity), alias);
}

export function readerPermissionClause(reader: Reader, alias = ""): { clause: string; bindings: (string | number)[] } {
  if (reader.admin) return { clause: "", bindings: [] };
  const p = alias ? `${alias}.` : "";
  // Qualified even without an alias: inside the subqueries a bare `directory_id`
  // resolves to the grants table's own column, which turns the comparison into a
  // tautology and silently breaks the ACL once the grants table has any row.
  const dir = `${alias ? `${alias}.` : "entries."}directory_id`;
  return {
    clause: `${p}clearance_level >= ? AND (${dir} IS NULL OR NOT EXISTS (SELECT 1 FROM brain_directory_grants _dg0 WHERE _dg0.directory_id = ${dir}) OR EXISTS (SELECT 1 FROM brain_directory_grants _dg1 WHERE _dg1.directory_id = ${dir} AND _dg1.user_id = ? AND _dg1.can_read = 1))`,
    bindings: [reader.floor, reader.userId],
  };
}

function permittedWorkspace(identity: Identity, workspaceId: string): boolean {
  return workspaceId === identity.personalWorkspaceId || identity.companyWorkspaceIds.includes(workspaceId);
}

/** Validate the security metadata on a new capture or imported/mirrored file. */
export async function resolveWritePermission(
  env: Env,
  identity: Identity,
  requestedClearance?: unknown,
  requestedDirectoryId?: unknown,
  sourcePath?: unknown,
): Promise<PermissionResult> {
  let directoryId: string | null = null;
  let directoryClearance = DEFAULT_CLEARANCE;
  if (requestedDirectoryId !== undefined && requestedDirectoryId !== null && requestedDirectoryId !== "") {
    if (typeof requestedDirectoryId !== "string" || !requestedDirectoryId.trim()) {
      return { ok: false, status: 400, error: "directory_id must be a non-empty string" };
    }
    directoryId = requestedDirectoryId.trim();
    const directory = await env.DB.prepare(
      `SELECT id, workspace_id, default_clearance FROM brain_directories WHERE id = ?`,
    ).bind(directoryId).first<{ id: string; workspace_id: string; default_clearance: number }>();
    if (!directory) return { ok: false, status: 404, error: "Directory not found" };
    if (!permittedWorkspace(identity, directory.workspace_id)) {
      return { ok: false, status: 403, error: "You do not belong to this directory's workspace" };
    }
    directoryClearance = normalizeClearance(directory.default_clearance) ?? DEFAULT_CLEARANCE;
    if (identity.role !== "admin") {
      const acl = await env.DB.prepare(
        `SELECT COUNT(*) AS total, MAX(CASE WHEN user_id = ? AND can_write = 1 THEN 1 ELSE 0 END) AS own_write FROM brain_directory_grants WHERE directory_id = ?`,
      ).bind(identity.userId, directoryId).first<{ total: number; own_write: number }>();
      if (Number(acl?.total ?? 0) > 0 && Number(acl?.own_write ?? 0) !== 1) {
        return { ok: false, status: 403, error: "You cannot write to this directory" };
      }
    }
  }

  const clearanceLevel = normalizeClearance(requestedClearance, directoryClearance);
  if (clearanceLevel === null) {
    return { ok: false, status: 400, error: `clearance_level must be an integer from ${CLEARANCE_MIN} to ${CLEARANCE_MAX}` };
  }
  if (identity.role !== "admin" && clearanceLevel < identityClearanceFloor(identity)) {
    return { ok: false, status: 403, error: `Your account may not write memories more restricted than P${identityClearanceFloor(identity)}` };
  }
  const safePath = sourcePath === undefined || sourcePath === null || sourcePath === "" ? null : String(sourcePath).slice(0, 500);
  return { ok: true, clearanceLevel, directoryId, sourcePath: safePath };
}
