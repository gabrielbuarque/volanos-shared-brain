import type { Env } from "../env";
import type { Chunk } from "./tree";
import { formatExamples, loadExamplePool, pickExamples, type FeedbackExample } from "./feedback";
import { levelCriteria, parseLevel, rubricInstructions, type LevelText } from "./levels";

/**
 * Client for TypeSafe's Jev (`POST /v1/systemone`, a Choice question per chunk).
 * Jev only chooses among the rubric's options and returns the probability of
 * each. It never reasons about the text and it never decides what is published:
 * decide.ts does that, with fixed rules.
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_BATCH_SIZE = 13;
const JEV_PARALLEL = 4;

export interface LevelProbability { level: number; p: number }

export interface Classification {
  /** Jev's pick. */
  level: number;
  confidence: number;
  /** Three most probable levels, best first. */
  top3: LevelProbability[];
  model: string;
}

/** A chunk Jev could not classify (outage, bad payload). decide() fails closed on these. */
export type ClassifyResult = Classification | null;

export function jevConfigured(env: Env): boolean {
  return !!env.JEV_API_KEY;
}

export function batches<T>(items: readonly T[], size = JEV_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildRequest(batch: readonly Chunk[], levels: readonly LevelText[], model = "jev-latest", examples: readonly FeedbackExample[] = []) {
  const state = formatExamples(examples) + batch.map((c, i) => `[${i + 1}] (${c.path})\n${c.text}`).join("\n\n---\n\n");
  const criteria = levelCriteria(levels);
  const questions: Record<string, unknown> = {};
  batch.forEach((_, i) => {
    questions[`c${i}`] = {
      type: "choice",
      instructions: `${rubricInstructions()}\n\nClassifique apenas o trecho [${i + 1}].`,
      criteria,
    };
  });
  return { state, model, questions };
}

export function parseAnswer(answer: any, fallbackModel: string): Classification | null {
  const probs = answer?.probabilities;
  if (!probs || typeof probs !== "object") return null;
  const ranked: LevelProbability[] = [];
  for (const [option, p] of Object.entries(probs)) {
    const level = parseLevel(option);
    if (level !== null && typeof p === "number" && Number.isFinite(p)) ranked.push({ level, p });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.p - a.p || a.level - b.level);
  const picked = typeof answer.choice === "string" ? parseLevel(answer.choice) : null;
  const level = picked ?? ranked[0].level;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : ranked[0].p;
  return { level, confidence, top3: ranked.slice(0, 3), model: fallbackModel };
}

async function classifyBatch(env: Env, batch: readonly Chunk[], levels: readonly LevelText[], examples: readonly FeedbackExample[]): Promise<ClassifyResult[]> {
  try {
    const res = await fetch(env.JEV_API_URL || JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.JEV_API_KEY}` },
      body: JSON.stringify(buildRequest(batch, levels, "jev-latest", examples)),
    });
    if (!res.ok) throw new Error(`Jev returned ${res.status}`);
    const payload = (await res.json()) as { model?: string; answers?: Record<string, unknown> };
    return batch.map((_, i) => parseAnswer(payload.answers?.[`c${i}`], payload.model ?? "jev"));
  } catch (e) {
    console.error("jev batch failed (chunks fail closed):", e);
    return batch.map(() => null);
  }
}

/** Classify every chunk, 13 per call, a few calls at a time. Result order matches `chunks`. */
export async function classifyChunks(env: Env, chunks: readonly Chunk[], levels: readonly LevelText[], workspaceId?: string): Promise<ClassifyResult[]> {
  const groups = batches(chunks);
  // Decisions the owner already made in this workspace, closest to this batch.
  const pool = await loadExamplePool(env, workspaceId);
  const examplesFor = groups.map(g => pickExamples(pool, g));
  const out: ClassifyResult[][] = new Array(groups.length);
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const i = next++;
      out[i] = await classifyBatch(env, groups[i], levels, examplesFor[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JEV_PARALLEL, groups.length) }, worker));
  return out.flat();
}
