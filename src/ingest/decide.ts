import type { ClassifyResult } from "./jev";

/**
 * What happens to a classified chunk. Fixed rules, never an AI call: Jev picks a
 * level, this file decides what the level means for the person who sent it.
 */

export const LOW_CONFIDENCE = 0.6;
export const MAX_LEVEL_GAP = 3;
/** A runner-up below this probability is noise, not ambiguity (a 95/5 split is not a toss-up). */
export const MIN_RUNNER_UP = 0.15;

export type Outcome = "publish" | "quarantine";

export interface Decision {
  /** Level the chunk is stored at (or queued at). */
  level: number;
  outcome: Outcome;
  /** Flagged for the owner's daily review (low confidence or ambiguous levels). */
  review: boolean;
  reason: "ok" | "above-submitter" | "low-confidence" | "ambiguous-levels" | "classifier-unavailable";
}

export interface SubmitterContext {
  /** The submitter's own floor: they publish directly at this level or more open. */
  floor: number;
  /** Skips the queue for chunks that are only flagged for review, never for ones above their level. */
  directPublish?: boolean;
}

/** Level to store given Jev's answer, applying the conservative rules. */
export function conservativeLevel(c: ClassifyResult): { level: number; review: boolean; reason: Decision["reason"] } {
  if (!c) return { level: 0, review: true, reason: "classifier-unavailable" };
  const [first, second] = c.top3;
  if (c.confidence < LOW_CONFIDENCE) {
    const level = second ? Math.min(first.level, second.level) : first.level;
    return { level: Math.min(level, c.level), review: true, reason: "low-confidence" };
  }
  if (second && second.p >= MIN_RUNNER_UP && Math.abs(first.level - second.level) > MAX_LEVEL_GAP) {
    return { level: Math.min(first.level, second.level, c.level), review: true, reason: "ambiguous-levels" };
  }
  return { level: c.level, review: false, reason: "ok" };
}

export function decide(c: ClassifyResult, who: SubmitterContext): Decision {
  const base = conservativeLevel(c);
  // More restrictive than the sender is allowed to publish: ask the owner.
  if (base.level < who.floor) {
    return { level: base.level, outcome: "quarantine", review: true, reason: base.reason === "ok" ? "above-submitter" : base.reason };
  }
  if (base.review && !who.directPublish) {
    return { level: base.level, outcome: "quarantine", review: true, reason: base.reason };
  }
  return { level: base.level, outcome: "publish", review: base.review, reason: base.reason };
}

/** A node is as restricted as its most restricted chunk. */
export function nodeLevel(chunkLevels: readonly number[]): number {
  return chunkLevels.length ? Math.min(...chunkLevels) : 12;
}
