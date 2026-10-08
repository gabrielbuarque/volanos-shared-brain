/**
 * The portable Markdown export, end to end: export a brain, wipe the database,
 * rebuild it from the files, and the P7 account finds exactly what it found before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { recallEntries } from "../../src/recall/search";
import { runExport, readExportCursor, resetExportCursor } from "../../src/export/run";
import { rebuildFromExport } from "../../src/export/rebuild";
import { parseDoc, renderDoc, META_KEYS } from "../../src/export/format";
import { slugify, shortId, entryPath } from "../../src/export/layout";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { MemoryRepo } from "../helpers/memory-repo";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

const T0 = Date.UTC(2026, 0, 10);
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

interface Brain { sqlite: SqliteD1; env: Env; company: string; bob: Identity; bobToken: string }
const brains: Brain[] = [];

const run = (b: Brain, sql: string, ...args: unknown[]) => b.sqlite.db.prepare(sql).bind(...args).run();
const rows = async <T = Record<string, any>>(b: Brain, sql: string, ...args: unknown[]) => (await b.sqlite.db.prepare(sql).bind(...args).all()).results as T[];

async function freshEnv(): Promise<{ sqlite: SqliteD1; env: Env }> {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    // The index is empty here: the comparison below is the keyword arm, which is exactly what survives a rebuild before re-embedding.
    VECTORIZE: makeVectorizeMock(),
  });
  await initializeDatabase(env);
  return { sqlite, env };
}

async function addBob(b: Pick<Brain, "env">): Promise<{ bob: Identity; bobToken: string }> {
  const m = await createMember(b.env, { name: "Bob" });
  await b.env.DB.prepare(`UPDATE users SET clearance_floor = 7 WHERE id = ?`).bind(m.member.userId).run();
  const company = (await b.env.DB.prepare(`SELECT id FROM workspaces WHERE kind = 'company' LIMIT 1`).first<{ id: string }>())!.id;
  return {
    bobToken: m.token,
    bob: { userId: m.member.userId, role: "member", personalWorkspaceId: m.member.personalWorkspaceId, companyWorkspaceIds: [company], defaultShare: "" as const, clearanceFloor: 7 } as Identity,
  };
}

async function seededBrain(): Promise<Brain> {
  const { sqlite, env } = await freshEnv();
  const roots = await ensureTenantBootstrap(env);
  const brain = { sqlite, env, company: roots.companyWorkspaceId } as Brain;
  Object.assign(brain, await addBob(brain));
  brains.push(brain);
  await run(brain, `INSERT INTO workspaces (id, kind, name, created_at) SELECT id, kind, 'Volanos', created_at FROM workspaces WHERE 1 = 0`);
  await run(brain, `UPDATE workspaces SET name = 'Volanos' WHERE id = ?`, brain.company);
  await run(brain, `INSERT INTO brain_directories (id, workspace_id, parent_id, name, path, default_clearance, owner_id, created_at) VALUES ('dir-fin', ?, NULL, 'Q3', 'Finance/Q3', 12, 'owner', ?)`, brain.company, T0);
  const seed = (id: string, content: string, level: number, over: Record<string, unknown> = {}) => run(brain,
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level, directory_id, source_path, version, superseded_by, archived_at)
     VALUES (?, ?, ?, 'upload', ?, ?, '[]', ?, 'author-1', ?, ?, ?, ?, ?, ?)`,
    id, content, JSON.stringify(over.tags ?? ["budget"]), T0, over.updatedAt ?? T0 + 1000, brain.company, level, over.dir ?? null, over.sourcePath ?? null, over.version ?? 1, over.supersededBy ?? null, over.archivedAt ?? null);
  await seed("11111111-aaaa-bbbb-cccc-0000000p0000", "# Acquisition budget\nP0 only: the acquisition budget is 4.2M.", 0, { dir: "dir-fin" });
  await seed("11111111-aaaa-bbbb-cccc-0000000p0003", "# Salary budget\nP3 salary budget.", 3);
  await seed("11111111-aaaa-bbbb-cccc-0000000p0005", "# Vendor budget\nP5 vendor budget.", 5);
  await seed("11111111-aaaa-bbbb-cccc-0000000p0007", "# Team budget\nP7 team budget, current text.\n\nWith  odd   spacing,\ttabs and \"quotes\": yes.\n", 7, { version: 3, tags: ["budget", "status:canonical"], sourcePath: "docs/team.md" });
  await seed("11111111-aaaa-bbbb-cccc-0000000p0009", "# Public budget\nP9 public budget — acentuação: reunião, decisão.", 9, { dir: "dir-fin" });
  await seed("11111111-aaaa-bbbb-cccc-00000000dead", "# Old budget\nSuperseded budget note.", 7, { supersededBy: "11111111-aaaa-bbbb-cccc-0000000p0007", tags: ["budget", "status:deprecated"] });
  await seed("11111111-aaaa-bbbb-cccc-0000000arch1", "# Archived budget\nArchived note.", 9, { archivedAt: T0 + 5, tags: ["budget", "status:deprecated"] });
  await run(brain, `INSERT INTO entry_versions (id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at) VALUES ('ver-1', '11111111-aaaa-bbbb-cccc-0000000p0007', 1, '# Team budget\nP7 team budget, first draft.', '["budget"]', 7, NULL, NULL, 'author-1', 'edit', ?)`, T0 + 10);
  await run(brain, `INSERT INTO entry_versions (id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at) VALUES ('ver-2', '11111111-aaaa-bbbb-cccc-0000000p0007', 2, '# Team budget\nP7 team budget, second draft.', '["budget"]', 7, NULL, NULL, 'system:aging-compact', 'compact', ?)`, T0 + 20);
  return brain;
}

const recallIds = async (b: Brain, q: string) => {
  const { matches } = await recallEntries({ query: q, topK: 10, synthesize: false }, b.env, ctx, undefined, { identity: b.bob });
  return matches.map(m => `${m.id}|${m.content}`).sort();
};

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); while (brains.length) brains.pop()!.sqlite.close(); });

describe("file format", () => {
  it("writes the documented front matter and parses it back byte for byte", () => {
    const body = "line one\n\n  indented\n---\nnot a fence\n";
    const text = renderDoc({ id: "x", title: "T: \"q\"", clearance_level: 4, tags: ["a", "b"], canonical: false, directory_id: null }, body);
    const doc = parseDoc(text)!;
    expect(doc.body).toBe(body);
    expect(doc.meta).toMatchObject({ id: "x", title: "T: \"q\"", clearance_level: 4, tags: ["a", "b"], canonical: false, directory_id: null });
    expect(parseDoc("# just markdown")).toBeNull();
    expect(parseDoc("---\nid: plain-yaml\nclearance_level: 3\n---\n\nbody")!.meta).toMatchObject({ id: "plain-yaml", clearance_level: 3 });
    expect(META_KEYS.slice(0, 14)).toEqual(["id", "title", "clearance_level", "workspace_id", "directory_id", "source", "source_path", "author", "created_at", "updated_at", "version", "status", "canonical", "tags"]);
  });

  it("derives stable, safe paths: <workspace>/<directory>/<slug>-<short id>.md", () => {
    expect(slugify("Reunião: Decisão — Q3/2026!")).toBe("reuniao-decisao-q3-2026");
    expect(shortId("9b2c1f00-1111-4aaa-bbbb-abcdef123456")).toBe("abcdef123456".slice(-10));
    const p = entryPath({ workspace: { id: "w1", name: "Volanos", kind: "company" }, directoryPath: "Finance/../Q3", content: "# Hello World\nx", id: "abc-123" });
    expect(p).toBe("volanos/finance/q3/hello-world-abc123.md");
    expect(p).not.toContain("..");
  });
});

describe("export", () => {
  it("is off until a repository is configured", async () => {
    const b = await seededBrain();
    const out = await runExport(b.env);
    expect(out).toMatchObject({ ok: false, status: "disabled" });
  });

  it("commits every memory once, with the documented message, layout and front matter", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    const out = await runExport(b.env, { repo });
    expect(out).toMatchObject({ ok: true, status: "committed", created: 7, changed: 0, archived: 2 });
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0].message.split("\n")[0]).toBe("export: 7 novas, 0 alteradas, 2 arquivadas");

    const paths = repo.entryPaths().join("\n");
    expect(paths).toContain("volanos/finance/q3/acquisition-budget-");
    expect(paths).toContain("volanos/finance/q3/public-budget-");
    expect(paths).toContain("volanos/_geral/team-budget-");
    expect(repo.historyPaths()).toHaveLength(2);
    expect(repo.historyPaths()[0]).toMatch(/^_history\/volanos\/[a-z0-9]+\/v0001\.md$/);

    const p7 = [...repo.files.entries()].find(([p]) => p.includes("team-budget-"))![1];
    const doc = parseDoc(p7)!;
    expect(doc.meta).toMatchObject({
      id: "11111111-aaaa-bbbb-cccc-0000000p0007", title: "Team budget", clearance_level: 7, workspace_id: b.company,
      directory_id: null, source: "upload", source_path: "docs/team.md", author: "author-1", version: 3,
      status: "active", canonical: true, tags: ["budget", "status:canonical"],
    });
    expect(doc.body).toBe("# Team budget\nP7 team budget, current text.\n\nWith  odd   spacing,\ttabs and \"quotes\": yes.\n");
    const statuses = [...repo.files.values()].map(t => parseDoc(t)?.meta.status).filter(Boolean);
    expect(statuses.filter(s => s === "superseded")).toHaveLength(1);
    expect(statuses.filter(s => s === "archived")).toHaveLength(1);
    // Every automatic run is in the audit trail under its system author.
    expect(await rows(b, `SELECT actor_id, event FROM admin_events WHERE event = 'export_run'`)).toEqual([{ actor_id: "system:export", event: "export_run" }]);
    expect(await rows(b, `SELECT job, actor_id, ok FROM job_runs`)).toEqual([{ job: "export", actor_id: "system:export", ok: 1 }]);
    // The repository holds P0.
    expect([...repo.files.values()].join("\n")).toContain("the acquisition budget is 4.2M");
  });

  it("is incremental: a second run with nothing new makes no commit; an edit changes only its file", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(b.env, { repo });
    expect((await runExport(b.env, { repo })).status).toBe("nothing");
    expect(repo.commits).toHaveLength(1);

    await run(b, `UPDATE entries SET content = '# Vendor budget\nP5 vendor budget, revised.', updated_at = ? WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0005'`, T0 + 99_000);
    await run(b, `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level) VALUES ('new-one-0001', '# Brand new\nfresh', '[]', 'api', ?, ?, '[]', ?, 'u', 12)`, T0 + 100_000, T0 + 100_000, b.company);
    const out = await runExport(b.env, { repo });
    expect(out).toMatchObject({ created: 1, changed: 1, archived: 0 });
    expect(repo.commits[1].message.split("\n")[0]).toBe("export: 1 novas, 1 alteradas, 0 arquivadas");
    expect(repo.commits[1].changes).toHaveLength(2);
    expect((await readExportCursor(b.env)).lastCommit).toBe("c2");
  });

  it("moves a file when the title changes, and removes the file of a memory forgotten in the app", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(b.env, { repo });
    await run(b, `UPDATE entries SET content = '# Renamed vendor plan\nbody', updated_at = ? WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0005'`, T0 + 50_000);
    await runExport(b.env, { repo });
    const paths = repo.entryPaths();
    expect(paths.filter(p => p.includes(shortId("11111111-aaaa-bbbb-cccc-0000000p0005")))).toEqual([`volanos/_geral/renamed-vendor-plan-${shortId("11111111-aaaa-bbbb-cccc-0000000p0005")}.md`]);

    // Deleted through the app: the audit trail carries a `deleted` event.
    await run(b, `DELETE FROM entries WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0003'`);
    await run(b, `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('ev1', '11111111-aaaa-bbbb-cccc-0000000p0003', 'u', 'deleted', '{}', ?)`, T0 + 60_000);
    const out = await runExport(b.env, { repo });
    expect(out.removed).toBe(1);
    expect(repo.entryPaths().some(p => p.includes("salary-budget"))).toBe(false);
  });

  it("never empties its own backup when memories merely vanish from the database", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(b.env, { repo });
    await run(b, `DELETE FROM entries`);
    await resetExportCursor(b.env);
    const out = await runExport(b.env, { repo });
    expect(out.removed).toBe(0);
    expect(repo.entryPaths()).toHaveLength(7);
  });

  it("reports a refused push without losing its place", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    repo.failNextCommit = true;
    const failed = await runExport(b.env, { repo });
    expect(failed).toMatchObject({ ok: false, status: "error", error: "push refused" });
    expect((await readExportCursor(b.env)).ts).toBe(0);
    expect((await runExport(b.env, { repo })).created).toBe(7);
  });

  it("caps one run and picks up the rest on the next", async () => {
    const b = await seededBrain();
    const repo = new MemoryRepo();
    const first = await runExport(b.env, { repo, maxEntries: 3 });
    expect(first).toMatchObject({ created: 3, more: true });
    const second = await runExport(b.env, { repo, maxEntries: 3 });
    const third = await runExport(b.env, { repo, maxEntries: 3 });
    expect(first.created + second.created + third.created).toBe(7);
    expect(repo.entryPaths()).toHaveLength(7);
  });
});

describe("rebuild from the export", () => {
  it("export, wipe the database, rebuild: the P7 account finds the same memories as before", async () => {
    const before = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(before.env, { repo });
    const expected = await Promise.all(["budget", "acquisition", "team budget", "salary", "public", "tags quotes"].map(q => recallIds(before, q)));
    expect(expected[0].length).toBeGreaterThan(0);
    expect(expected[0].join("\n")).not.toContain("P0 only");
    expect(expected[0].join("\n")).not.toContain("P3 salary");

    // A new, empty database, restored from nothing but the files.
    const { sqlite, env } = await freshEnv();
    const after = { sqlite, env } as Brain;
    brains.push(after);

    const dry = await rebuildFromExport(env, repo, { dryRun: true, limit: 1000, actor: "admin" });
    expect(dry).toMatchObject({ ok: true, dry_run: true, entries_created: 7, versions_created: 2, next_offset: null });
    expect(((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries`).first()) as any).n).toBe(0);

    const real = await rebuildFromExport(env, repo, { dryRun: false, limit: 1000, actor: "admin" });
    expect(real).toMatchObject({ ok: true, entries_created: 7, versions_created: 2, errors: [] });
    expect(real.pending_embeddings).toBe(7);

    // Idempotent by id.
    const again = await rebuildFromExport(env, repo, { dryRun: false, limit: 1000, actor: "admin" });
    expect(again).toMatchObject({ entries_created: 0, entries_unchanged: 7, versions_created: 0, versions_unchanged: 2 });

    // Accounts come back through the app; the company workspace is the restored one.
    const roots = await ensureTenantBootstrap(env);
    expect(roots.companyWorkspaceId).toBe(before.company);
    Object.assign(after, { company: roots.companyWorkspaceId }, await addBob(after));

    const restored = await Promise.all(["budget", "acquisition", "team budget", "salary", "public", "tags quotes"].map(q => recallIds(after, q)));
    expect(restored).toEqual(expected);

    // Levels, directories, versions and the exact text survived.
    const p0 = (await rows(after, `SELECT clearance_level, directory_id, content, version FROM entries WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0000'`))[0];
    expect(p0).toMatchObject({ clearance_level: 0, directory_id: "dir-fin", version: 1 });
    const p7 = (await rows(after, `SELECT content, version, source_path FROM entries WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0007'`))[0];
    expect(p7.content).toBe("# Team budget\nP7 team budget, current text.\n\nWith  odd   spacing,\ttabs and \"quotes\": yes.\n");
    expect(p7).toMatchObject({ version: 3, source_path: "docs/team.md" });
    expect((await rows(after, `SELECT version, content FROM entry_versions WHERE entry_id = '11111111-aaaa-bbbb-cccc-0000000p0007' ORDER BY version`)).map(r => r.version)).toEqual([1, 2]);
    expect((await rows(after, `SELECT path FROM brain_directories WHERE id = 'dir-fin'`))[0].path).toBe("Finance/Q3");
    expect((await rows(after, `SELECT superseded_by FROM entries WHERE id = '11111111-aaaa-bbbb-cccc-00000000dead'`))[0].superseded_by).toBe("11111111-aaaa-bbbb-cccc-0000000p0007");
  });

  it("attaches restored company memories to the deployment's own company workspace, and never rolls back newer work", async () => {
    const before = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(before.env, { repo });

    const { sqlite, env } = await freshEnv();
    const live = { sqlite, env } as Brain;
    brains.push(live);
    const roots = await ensureTenantBootstrap(env); // a new deployment with its OWN company workspace
    expect(roots.companyWorkspaceId).not.toBe(before.company);
    await run(live, `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, clearance_level) VALUES ('11111111-aaaa-bbbb-cccc-0000000p0005', '# Vendor budget\nnewer text, edited after the export', '[]', 'api', ?, ?, '[]', ?, 'u', 5)`, T0, T0 + 9_999_999, roots.companyWorkspaceId);

    const out = await rebuildFromExport(env, repo, { dryRun: false, limit: 1000, actor: "admin" });
    expect(out.mapped_workspaces).toEqual({ [before.company]: roots.companyWorkspaceId });
    expect(out.entries_kept_newer).toBe(1);
    const mine = await rows(live, `SELECT content FROM entries WHERE id = '11111111-aaaa-bbbb-cccc-0000000p0005'`);
    expect(mine[0].content).toContain("newer text");
    expect((await rows(live, `SELECT COUNT(*) AS n FROM entries WHERE workspace_id = ?`, roots.companyWorkspaceId))[0].n).toBe(7);
  });

  it("is resumable in slices and reports files it does not recognise instead of failing", async () => {
    const before = await seededBrain();
    const repo = new MemoryRepo();
    await runExport(before.env, { repo });
    repo.files.set("README.md", "# the export repo\n");
    const { sqlite, env } = await freshEnv();
    brains.push({ sqlite, env } as Brain);
    const first = await rebuildFromExport(env, repo, { dryRun: false, limit: 4, actor: "admin" });
    expect(first.next_offset).toBe(4);
    let offset: number | null = first.next_offset;
    const skipped = [...first.skipped_files];
    while (offset !== null) {
      const next = await rebuildFromExport(env, repo, { dryRun: false, offset, limit: 4, actor: "admin" });
      skipped.push(...next.skipped_files);
      offset = next.next_offset;
    }
    expect(skipped).toEqual(["README.md"]);
    expect(((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries`).first()) as any).n).toBe(7);
  });
});
