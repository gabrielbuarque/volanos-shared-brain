import type { Env } from "../env";

/**
 * History for memories. Nothing is erased when a memory is rewritten, merged,
 * compacted or archived: the text about to be replaced is copied into
 * `entry_versions` first, and `entries.version` moves forward. `restoreVersion`
 * brings any earlier text back as a NEW version, so restoring is itself recorded.
 *
 * A version row holds the text AS IT WAS at that version number, together with
 * the level and directory it had, so a restore can never lower a memory's
 * clearance by accident.
 */

export type VersionReason = "edit" | "merge" | "merge-superseded" | "compact" | "archive" | "restore" | "import";

export interface EntryVersion {
  id: string;
  entry_id: string;
  version: number;
  content: string;
  tags: string;
  clearance_level: number;
  directory_id: string | null;
  source_path: string | null;
  actor_id: string;
  reason: string;
  created_at: number;
}

/**
 * Copies the entry's current text into history under its current version number
 * and moves the entry to the next version, in one D1 batch (all or nothing).
 * Call it BEFORE the statement that overwrites the content.
 */
export async function snapshotAndBump(
  env: Env,
  entryId: string,
  opts: { actorId?: string; reason: VersionReason; now?: number },
): Promise<void> {
  const now = opts.now ?? Date.now();
  await env.DB.batch([
    env.DB.prepare(
      // scope-exempt: by-id: copies the row being rewritten by the caller, who already gated on read/edit access; the copy stays inside entry_versions
      `INSERT OR IGNORE INTO entry_versions (id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at)
       SELECT ?, id, version, content, tags, clearance_level, directory_id, source_path, ?, ?, ? FROM entries WHERE id = ?`,
    ).bind(`ver-${crypto.randomUUID()}`, opts.actorId ?? "", opts.reason, now, entryId),
    env.DB.prepare(`UPDATE entries SET version = version + 1 WHERE id = ?`).bind(entryId),
  ]);
}

export async function listVersions(env: Env, entryId: string): Promise<EntryVersion[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, entry_id, version, content, tags, clearance_level, directory_id, source_path, actor_id, reason, created_at
     FROM entry_versions WHERE entry_id = ? ORDER BY version DESC`,
  ).bind(entryId).all();
  return (results ?? []) as unknown as EntryVersion[];
}

/**
 * Puts the text of an earlier version back. The current text is snapshotted first
 * (so the restore can be undone), the entry moves to a new version, and the
 * compacted/superseded/archived markers are cleared. The caller re-embeds.
 * Returns the restored row's content, or null when there is no such version.
 */
export async function restoreVersion(
  env: Env,
  entryId: string,
  version: number,
  opts: { actorId: string },
): Promise<{ content: string; tags: string[] } | null> {
  const old = await env.DB.prepare(
    `SELECT content, tags FROM entry_versions WHERE entry_id = ? AND version = ?`,
  ).bind(entryId, version).first<{ content: string; tags: string }>();
  if (!old) return null;
  const now = Date.now();
  await snapshotAndBump(env, entryId, { actorId: opts.actorId, reason: "restore", now });
  await env.DB.prepare(
    `UPDATE entries SET content = ?, tags = ?, updated_at = ?, compacted_at = NULL, superseded_by = NULL, archived_at = NULL WHERE id = ?`,
  ).bind(old.content, old.tags, now, entryId).run();
  return { content: old.content, tags: JSON.parse(old.tags ?? "[]") };
}
