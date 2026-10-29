import type { Env } from "../env";
import type { Chunk } from "./tree";

/**
 * What the owner decided about a chunk Jev was unsure of, kept as an example for
 * the next classification. Jev only ever chooses among the rubric's options; the
 * examples are more context for that choice, they never publish anything.
 *
 * Scope: examples are per workspace and go only to Jev (the same service that
 * already receives every chunk to classify). They never reach a user, an LLM
 * provider or a response.
 */

export const FEEDBACK_MAX_EXAMPLES = 8;
export const FEEDBACK_TEXT_CHARS = 300;
const FEEDBACK_POOL = 200;

export interface FeedbackExample {
  text: string;
  level: number;
  /** The owner changed Jev's pick (as opposed to confirming it). */
  corrected: boolean;
  createdAt: number;
}

export interface FeedbackInput {
  workspaceId: string;
  entryId: string;
  text: string;
  jevLevel: number | null;
  jevConfidence: number | null;
  finalLevel: number;
  sourcePath: string | null;
  decidedBy: string;
  now?: number;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(w => w.length >= 4));
}

/** Examples closest to the batch (word overlap), corrections first, newest breaking ties. */
export function pickExamples(pool: readonly FeedbackExample[], chunks: readonly Chunk[], limit = FEEDBACK_MAX_EXAMPLES): FeedbackExample[] {
  if (!pool.length) return [];
  const batch = words(chunks.map(c => c.text).join(" "));
  const scored = pool.map(ex => {
    const w = words(ex.text);
    let hit = 0;
    for (const x of w) if (batch.has(x)) hit++;
    const overlap = w.size ? hit / Math.sqrt(w.size * Math.max(1, batch.size)) : 0;
    return { ex, score: overlap + (ex.corrected ? 0.25 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || b.ex.createdAt - a.ex.createdAt);
  return scored.slice(0, limit).map(s => s.ex);
}

export function formatExamples(examples: readonly FeedbackExample[]): string {
  if (!examples.length) return "";
  const lines = examples.map((e, i) => `E${i + 1} → P${e.level}${e.corrected ? " (corrigido pelo responsável)" : ""}: "${e.text.replace(/\s+/g, " ").slice(0, FEEDBACK_TEXT_CHARS)}"`);
  return `Exemplos já decididos por um responsável da empresa. Use só como referência de critério; não são trechos a classificar.\n${lines.join("\n")}\n\n=== Trechos a classificar ===\n`;
}

/** Keep an owner's decision as an example. Never throws: feedback must not block the approval. */
export async function recordFeedback(env: Env, input: FeedbackInput): Promise<void> {
  try {
    const now = input.now ?? Date.now();
    const corrected = input.jevLevel !== null && input.jevLevel !== input.finalLevel ? 1 : 0;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO classification_feedback (id, workspace_id, entry_id, jev_level, jev_confidence, final_level, corrected, text, source_path, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`fb-${input.entryId}`, input.workspaceId, input.entryId, input.jevLevel, input.jevConfidence, input.finalLevel, corrected, input.text.slice(0, 1600), input.sourcePath, input.decidedBy, now).run();
  } catch (e) {
    console.error("classification feedback not recorded:", e);
  }
}

/** Recent decisions of this workspace (one D1 query); narrow per batch with pickExamples. */
export async function loadExamplePool(env: Env, workspaceId: string | undefined): Promise<FeedbackExample[]> {
  if (!workspaceId) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT text, final_level AS level, corrected, created_at AS createdAt FROM classification_feedback WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ${FEEDBACK_POOL}`,
    ).bind(workspaceId).all<{ text: string; level: number; corrected: number; createdAt: number }>();
    return (results ?? []).map(r => ({ text: String(r.text), level: Number(r.level), corrected: Number(r.corrected) === 1, createdAt: Number(r.createdAt) }));
  } catch (e) {
    console.error("classification feedback not loaded:", e);
    return [];
  }
}
