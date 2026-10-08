import type { Env } from "../env";
import type { Config } from "../config";
import { D1_MAX_BOUND_PARAMS } from "../constants";

/**
 * Usage ranking: a memory that keeps being opened, cited or reached by a link
 * ranks a little higher; one nobody touches gradually stops getting the bonus.
 *
 * The bonus only ever ADDS to a score (the multiplier is 1 + bonus, bonus >= 0).
 * It cannot hide, demote or filter anything, which is why this runs always and has
 * no flag: the worst it can do is keep a well-used memory near the top for longer.
 *
 *   bonus = min(USAGE_BONUS_MAX, USAGE_BONUS_STEP * ln(1 + access_count))
 *           * 0.5 ^ (days since last access / half-life)
 *
 * The half-life depends on what the memory is: decisions stay relevant longer than
 * meeting notes.
 */

export type MemoryType = "decision" | "meeting" | "other";

const DECISION_TAGS = new Set(["decision", "decisions", "decisao", "decisoes", "adr", "kind:decision"]);
const MEETING_TAGS = new Set(["meeting", "meetings", "meeting-notes", "reuniao", "reunioes", "ata", "atas", "kind:meeting"]);
const MEETING_SOURCES = /meeting|reuniao|reunião|transcript|wispr|calendar/i;

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function memoryTypeOf(tags: readonly string[], source = ""): MemoryType {
  const folded = tags.map(fold);
  if (folded.some(t => DECISION_TAGS.has(t) || t.startsWith("decision:") || t.startsWith("decisao:"))) return "decision";
  if (folded.some(t => MEETING_TAGS.has(t) || t.startsWith("meeting:") || t.startsWith("reuniao:")) || MEETING_SOURCES.test(source)) return "meeting";
  return "other";
}

export function halfLifeDays(type: MemoryType, cfg: Readonly<Config>): number {
  if (type === "decision") return cfg.USAGE_HALF_LIFE_DECISION_DAYS;
  if (type === "meeting") return cfg.USAGE_HALF_LIFE_MEETING_DAYS;
  return cfg.USAGE_HALF_LIFE_DEFAULT_DAYS;
}

export interface UsageSignal {
  accessCount: number;
  lastAccessedAt: number | null;
  tags: readonly string[];
  source?: string;
}

/** The extra fraction of its score a memory earns from use. Always >= 0. */
export function usageBonus(signal: UsageSignal, cfg: Readonly<Config>, now = Date.now()): number {
  const count = Math.max(0, Math.trunc(signal.accessCount || 0));
  if (!count || !signal.lastAccessedAt) return 0;
  const base = Math.min(cfg.USAGE_BONUS_MAX, cfg.USAGE_BONUS_STEP * Math.log1p(count));
  const ageDays = Math.max(0, (now - signal.lastAccessedAt) / 86_400_000);
  const half = Math.max(1, halfLifeDays(memoryTypeOf(signal.tags, signal.source), cfg));
  const bonus = base * Math.pow(0.5, ageDays / half);
  return Number.isFinite(bonus) && bonus > 0 ? bonus : 0;
}

/**
 * Counts one access for each id. Called with ids the caller was already served
 * (so it never reveals anything), after the response, and never throws: a lost
 * count is a slightly lower ranking bonus, never a failed request.
 */
export async function recordAccess(
  env: Env,
  ids: readonly string[],
  now = Date.now(),
): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return;
  try {
    for (let i = 0; i < unique.length; i += D1_MAX_BOUND_PARAMS - 1) {
      const batch = unique.slice(i, i + D1_MAX_BOUND_PARAMS - 1);
      await env.DB.prepare(
        `UPDATE entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${batch.map(() => "?").join(", ")})`,
      ).bind(now, ...batch).run();
    }
  } catch (e) {
    console.error("access count update failed (non-fatal):", e);
  }
}

/** recordAccess behind ctx.waitUntil, for request handlers. */
export function recordAccessAfterResponse(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, ids: readonly string[]): void {
  if (!ids.length) return;
  ctx.waitUntil(recordAccess(env, ids));
}
