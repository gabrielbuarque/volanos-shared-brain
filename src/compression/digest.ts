import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { captureEntry } from "../capture/entry";
import { DIGEST_MAX_TOKENS, LLM_MODEL } from "../constants";
import { chatText } from "../llm/provider";
import { type Reader } from "../lib/permissions";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import {
  compressionEligibilitySql,
  isTopicTag,
} from "./eligibility";

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env,
  config: Readonly<Config> = DEFAULTS
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Based on these stored memories tagged "${tag}", write a single cohesive paragraph describing the current state of this area — what has been done, decided, and is being worked toward. Write as one flowing paragraph, not a list.

Memories:
${memoriesList}

State of "${tag}":`;

  let digest = "";
  try {
    digest = await chatText(env, config, [{ role: "user", content: prompt }], { maxTokens: DIGEST_MAX_TOKENS });
  } catch (e) {
    console.error("synthesizeDigest LLM call failed (non-fatal):", e);
  }

  return digest.trim();
}

/** Mark digest sources and retry individually if the batch fails. */
async function markSourcesRolledUp(env: Env, ids: string[], digestId: string): Promise<void> {
  if (!ids.length) return;
  const note = `\n\n[Digest: ${digestId}]`;
  const mark = (id: string) => env.DB.prepare(
    `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ?`
  ).bind(note, id);

  try {
    await env.DB.batch(ids.map(mark));
  } catch (e) {
    console.error("Batched rolled-up mark failed; retrying per row (non-fatal):", e);
    for (const id of ids) {
      try {
        await mark(id).run();
      } catch (err) {
        console.error(`Failed to update source entry ${id} (non-fatal):`, err);
      }
    }
  }
}

export interface CompressTagOptions {
  /** When set, roll up only these workspaces and scope the 24h cooldown per workspace. */
  workspaceIds?: string[];
  /** Whoever asked (manual GET /digest). Sources above their level never enter the digest. */
  reader?: Reader;
}

/**
 * A digest is a new memory written from many. Two rules keep it from becoming a
 * way around the clearance levels:
 *   - it is only built from rows the requester may read (clearance_level >=
 *     their floor), and never from rows in a directory with an ACL, because the
 *     digest itself carries no directory;
 *   - it is partitioned by clearance_level and each digest is stored AT that
 *     level, so a P0 rollup is never readable by a P12 account.
 */
const NO_ACL_DIRECTORY_SQL = `(directory_id IS NULL OR NOT EXISTS (SELECT 1 FROM brain_directory_grants _g WHERE _g.directory_id = entries.directory_id))`;

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext,
  opts?: CompressTagOptions,
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Reject bookkeeping tags before the configuration lookup.
  if (!isTopicTag(tag)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }
  const cfg = await resolveConfig(env);

  // Select and summarize one workspace at a time so private memories cannot be
  // pooled into a digest visible from another workspace.
  const scoped = Boolean(opts?.workspaceIds?.length);
  let workspaces: string[];
  if (scoped) {
    workspaces = opts!.workspaceIds!;
  } else {
    const { results: workspaceRows } = await env.DB.prepare(
      // scope-exempt: cron: workspace discovery for the partitioned rollup below; returns workspace ids, never a row's content
      `SELECT DISTINCT workspace_id FROM entries`
    ).all();
    workspaces = (workspaceRows as { workspace_id?: string }[]).map(r => r.workspace_id ?? "");
    if (!workspaces.length) workspaces.push("");
  }

  let synthesizedId: string | null = null;
  let entriesUsed = 0;
  let text = "";

  for (const workspaceId of workspaces) {
    // The 24h cooldown stays corpus-wide on purpose for the nightly cron: it gates
    // repetition, not visibility, so checking it across workspaces can only ever
    // postpone a digest by a day — it never moves one user's content into another
    // user's row. Manual GET /digest passes workspaceIds and gets a per-workspace
    // check instead, so one member's recent rollup does not block another's.
    const recentSynth = await env.DB.prepare(`
      SELECT id FROM entries
      WHERE tags LIKE '%"synthesized"%'
        AND tags LIKE ? ${TAG_LIKE_ESCAPE}
        AND created_at > ?
        AND workspace_id = ?
      LIMIT 1
    `).bind(tagLikePattern(tag), Date.now() - 86400000, workspaceId).first();

    if (recentSynth) {
      continue;
    }

    // The requester's own level bounds the sources; the cron has no requester and
    // takes every level, but digests each level separately (below).
    const floorSql = opts?.reader && !opts.reader.admin ? ` AND clearance_level >= ${Math.max(0, Math.min(12, Math.trunc(opts.reader.floor)))}` : "";
    const { results: rawEntries } = await env.DB.prepare(`
      SELECT id, content, clearance_level FROM entries
      WHERE tags LIKE ? ${TAG_LIKE_ESCAPE}
        AND tags NOT LIKE '%"synthesized"%'
        AND tags NOT LIKE '%"auto-pattern"%'
        AND tags NOT LIKE '%"auto-insight"%'
        AND tags NOT LIKE '%"rolled-up"%'
        AND tags NOT LIKE '%"capsule:%'
        AND tags NOT LIKE '%"capsule-slot:%'
        AND ${compressionEligibilitySql("", cfg)}
        AND workspace_id = ?
        AND ${NO_ACL_DIRECTORY_SQL}${floorSql}
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(tagLikePattern(tag), Date.now() - cfg.COMPRESSION_MIN_AGE_MS, workspaceId).all();

    // One partition per clearance level; a partition needs its own 10 entries.
    const byLevel = new Map<number, { id: string; content: string }[]>();
    for (const r of rawEntries) {
      const level = Number.isInteger(r.clearance_level) ? Number(r.clearance_level) : 12;
      const list = byLevel.get(level) ?? [];
      list.push({ id: r.id as string, content: r.content as string });
      byLevel.set(level, list);
    }

    for (const [level, rows] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      if (rows.length < 10) continue;
      const digestText = await synthesizeDigest(tag, rows, env, cfg);
      if (!digestText) continue;

      const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]

${digestText}`;
      // The digest inherits the partition's workspace AND clearance level and keeps
      // actor "" — system-authored, like every pre-team pipeline row.
      const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx, cfg,
        { workspaceId, actorId: "", clearanceLevel: level });

      if (result.status !== "stored" && result.status !== "flagged") {
        continue;
      }

      await markSourcesRolledUp(env, rows.map(r => r.id), result.id);

      // First successful digest defines the returned text/id; counts accumulate across
      // workspaces so a caller still learns how much was compressed tonight.
      if (!synthesizedId) {
        synthesizedId = result.id;
        text = digestText;
      }
      entriesUsed += rows.length;
    }
  }

  return { synthesizedId, entriesUsed, text };
}
