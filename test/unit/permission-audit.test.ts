/**
 * Permission ratchet (docs/volanos/permission-audit.md).
 *
 * `scripts/check-scope.mjs` proves every read of `entries` carries SOME scope.
 * This test adds the rule the audit introduced: reads in src/recall, src/routes
 * and src/mcp go through `scopedEntriesQuery` (src/lib/scoped-entries.ts), which
 * puts workspace + clearance + directory ACL in the WHERE clause, before ORDER BY
 * and LIMIT, by construction.
 *
 * Reads written by hand before the helper existed are grandfathered per file and
 * can only go down. A NEW hand-written `FROM entries` / `JOIN entries` in these
 * folders fails here — move it to the helper, or (if it truly cannot be: by-id
 * lookups of ids the caller was already served, counters that return no content)
 * annotate it `scope-exempt:` / `scope-checked:` with the reason and lower the
 * number below only when you remove one.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { scopedEntriesQuery } from "../../src/lib/scoped-entries";
import { entryPermissionClause } from "../../src/lib/permissions";
import { scopeWhere } from "../../src/lib/scope";
import type { Identity } from "../../src/lib/identity";

const ROOT = resolve(import.meta.dirname, "../..");
const FOLDERS = ["src/recall", "src/routes", "src/mcp"];
const HELPERS = /scopedEntriesQuery|selectScopedEntries|hydrateScopedEntries/;
const ANNOTATED = /scope-exempt:|scope-checked:|scope-outer-join:/;
const READ = /\b(?:FROM|JOIN)\s+entries\b/;

/**
 * Hand-written entries reads per file, as of the audit. Lower it when you migrate
 * one to the helper; never raise it — use the helper instead.
 */
const GRANDFATHERED: Record<string, number> = {
  "src/mcp/server.ts": 1,
  "src/recall/distill.ts": 1,
  "src/recall/search.ts": 3,
  "src/routes/admin.ts": 21,
  "src/routes/brief.ts": 7,
  "src/routes/entries.ts": 3,
  "src/routes/shared-brain.ts": 1,
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = resolve(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

interface Read { file: string; line: number; helper: boolean; annotated: boolean }

function collect(): Read[] {
  const reads: Read[] = [];
  for (const folder of FOLDERS) {
    for (const abs of walk(resolve(ROOT, folder))) {
      const file = relative(ROOT, abs).replaceAll("\\", "/");
      const lines = readFileSync(abs, "utf8").split("\n");
      lines.forEach((text, i) => {
        const code = text.trim();
        if (!READ.test(text) || code.startsWith("//") || code.startsWith("*")) return;
        const window = lines.slice(Math.max(0, i - 14), i + 8).join("\n");
        reads.push({ file, line: i + 1, helper: HELPERS.test(window), annotated: ANNOTATED.test(window) });
      });
    }
  }
  return reads;
}

const member = { userId: "u1", role: "member", personalWorkspaceId: "wp", companyWorkspaceIds: ["wc"], defaultShare: "" as const, clearanceFloor: 7 } as Identity;
const admin = { ...member, role: "admin" } as Identity;

describe("entries reads in recall, routes and mcp", () => {
  const reads = collect();

  it("every read is scoped by the helper or carries an annotated licence", () => {
    const bare = reads.filter(r => !r.helper && !r.annotated && !/scope|permission/i.test(readFileSync(resolve(ROOT, r.file), "utf8").split("\n").slice(Math.max(0, r.line - 14), r.line + 8).join("\n")));
    expect(bare.map(r => `${r.file}:${r.line}`), "unscoped read of entries — use scopedEntriesQuery()").toEqual([]);
  });

  it("does not add hand-written reads: new ones use scopedEntriesQuery", () => {
    const counts: Record<string, number> = {};
    for (const r of reads.filter(r => !r.helper)) counts[r.file] = (counts[r.file] ?? 0) + 1;
    for (const [file, n] of Object.entries(counts)) {
      expect(n, `${file} grew from ${GRANDFATHERED[file] ?? 0} to ${n} hand-written reads of entries; build the new one with scopedEntriesQuery()`).toBeLessThanOrEqual(GRANDFATHERED[file] ?? 0);
    }
  });
});

describe("the helper itself", () => {
  it("puts workspace, clearance and directory ACL before ORDER BY and LIMIT", () => {
    const q = scopedEntriesQuery(member, { select: "id, content", where: "content LIKE ?", bindings: ["%x%"], orderBy: "created_at DESC", limit: 5 });
    const clause = q.sql.indexOf("clearance_level >= ?");
    expect(clause).toBeGreaterThan(q.sql.indexOf("WHERE"));
    expect(clause).toBeLessThan(q.sql.indexOf("ORDER BY"));
    expect(q.sql.indexOf("ORDER BY")).toBeLessThan(q.sql.indexOf("LIMIT"));
    expect(q.bindings).toEqual(["%x%", "wp", "wc", 7, "u1", 5]);
  });

  it("qualifies directory_id so the ACL cannot degrade into a tautology", () => {
    for (const alias of ["", "e"]) {
      const { clause } = entryPermissionClause(member, alias);
      const column = alias ? `${alias}.directory_id` : "entries.directory_id";
      expect(clause.split(column).length - 1).toBe(3);
      expect(clause).not.toMatch(/= directory_id/);
    }
  });

  it("applies the same predicate through scopeWhere, aliased or not, and none of the clearance for admins", () => {
    expect(scopeWhere(member).clause).toContain("clearance_level >= ?");
    expect(scopeWhere(member, undefined, "a.workspace_id").clause).toContain("a.clearance_level >= ?");
    expect(scopeWhere(admin).clause).not.toContain("clearance_level");
  });
});
