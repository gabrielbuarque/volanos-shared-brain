import type { Env } from "../env";
import type { Config } from "../config";
import { JEV_URL } from "../ingest/jev";

/**
 * Reranking of recall candidates, after the permission filter and the dense/FTS
 * fusion, before PageIndex and the answering LLM.
 *
 * `RERANKER` = `jev` | `bge` | `off`:
 *   - jev: one `POST /v1/systemone` call grades every candidate on four criteria.
 *   - bge: Workers AI `@cf/baai/bge-reranker-base` (cross-encoder, no external vendor).
 *   - off: no reranking (the default).
 *
 * Two hard rules:
 *   1. Only candidates ALREADY hydrated through the caller's permission scope are
 *      passed in. This module never reads D1; it cannot widen what a caller may see.
 *   2. A search never fails because of the reranker. Timeout, HTTP error, bad
 *      payload, missing key: the original order is kept and `reranker_degraded` is
 *      logged (ids and a reason only, never memory text).
 */

export type RerankerMode = "jev" | "bge" | "off";

export const BGE_RERANKER_MODEL = "@cf/baai/bge-reranker-base";
/** Characters of each candidate sent to the grader. */
export const RERANK_SNIPPET_CHARS = 600;
export const RERANK_TITLE_CHARS = 90;

/** The four grades, best first. Keys are what Jev answers with. */
export const RERANK_CRITERIA: Record<string, string> = {
  "1.0": "Resposta direta à pergunta.",
  "0.7": "Mesmo assunto; ajuda a responder.",
  "0.3": "Tangencial.",
  "0.0": "Sem relação com a pergunta.",
};
const GRADE_VALUE: Record<string, number> = { "1.0": 1, "0.7": 0.7, "0.3": 0.3, "0.0": 0 };

export interface RerankInput {
  id: string;
  content: string;
  /** The score the pipeline already gave it (higher is better). */
  score: number;
}

export interface RerankInfo {
  /** True only when a reranker actually reordered this answer. */
  ran: boolean;
  mode: RerankerMode;
  ms: number;
  /** Why it did not run / was abandoned, when `ran` is false but a mode was configured. */
  degraded?: string;
  candidates: number;
}

export function rerankerMode(cfg: Readonly<Config>): RerankerMode {
  const v = String(cfg.RERANKER ?? "off").trim().toLowerCase();
  return v === "jev" || v === "bge" ? v : "off";
}

export function rerankerKey(env: Env): string | undefined {
  return env.TYPESAFE_API_KEY || env.JEV_API_KEY || undefined;
}

export const titleOf = (content: string): string => {
  const first = content.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  return first.length > RERANK_TITLE_CHARS ? `${first.slice(0, RERANK_TITLE_CHARS - 1)}…` : first || "(sem título)";
};

export function buildRerankRequest(query: string, items: readonly RerankInput[], model = "jev-latest") {
  const numbered = items.map((it, i) => `[${i + 1}] ${titleOf(it.content)}\n${it.content.slice(0, RERANK_SNIPPET_CHARS)}`).join("\n\n---\n\n");
  const state = `Pergunta: ${query}\n\nCandidatos:\n\n${numbered}`;
  const questions: Record<string, unknown> = {};
  items.forEach((_, i) => {
    questions[`r${i}`] = {
      type: "choice",
      instructions: `Quanto o candidato [${i + 1}] responde à pergunta? Avalie apenas o candidato [${i + 1}].`,
      criteria: RERANK_CRITERIA,
    };
  });
  return { state, model, questions };
}

export interface Grade { value: number; confidence: number }

/** Expected grade under Jev's probabilities, and how sure it is. Null when unusable. */
export function parseGrade(answer: any): Grade | null {
  const probs = answer?.probabilities;
  if (probs && typeof probs === "object") {
    let total = 0;
    let weighted = 0;
    let best = 0;
    for (const [option, p] of Object.entries(probs)) {
      const value = GRADE_VALUE[normaliseOption(option)];
      if (value === undefined || typeof p !== "number" || !Number.isFinite(p) || p < 0) continue;
      total += p;
      weighted += p * value;
      best = Math.max(best, p);
    }
    if (total > 0) {
      const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : best / total;
      return { value: weighted / total, confidence: clamp01(confidence) };
    }
  }
  const picked = typeof answer?.choice === "string" ? GRADE_VALUE[normaliseOption(answer.choice)] : undefined;
  if (picked !== undefined) {
    const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : 0.5;
    return { value: picked, confidence: clamp01(confidence) };
  }
  return null;
}

const normaliseOption = (option: string): string => {
  const n = Number(option);
  return Number.isFinite(n) ? n.toFixed(1) : option.trim();
};
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Final score = jevWeight × (Jev's grade, confidence-weighted) + (1 − jevWeight) × original.
 * Both sides are on [0, 1] (the original is divided by the best original score).
 * A grader that is unsure (low confidence) leans on the original ordering for its
 * share rather than dragging a candidate to an arbitrary place.
 */
export function blendScore(original: number, grade: Grade | null, jevWeight: number): number {
  if (!grade) return original;
  const graded = grade.confidence * grade.value + (1 - grade.confidence) * original;
  return jevWeight * graded + (1 - jevWeight) * original;
}

async function gradeWithJev(env: Env, query: string, items: readonly RerankInput[], timeoutMs: number): Promise<(Grade | null)[]> {
  const key = rerankerKey(env);
  if (!key) throw new Error("no_api_key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetch(env.JEV_API_URL || JEV_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildRerankRequest(query, items)),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ]);
    if (!res.ok) throw new Error(`http_${res.status}`);
    const payload = (await res.json()) as { answers?: Record<string, unknown> };
    return items.map((_, i) => parseGrade(payload.answers?.[`r${i}`]));
  } finally {
    clearTimeout(timer);
  }
}

async function gradeWithBge(env: Env, query: string, items: readonly RerankInput[], timeoutMs: number): Promise<(Grade | null)[]> {
  if (!env.AI) throw new Error("no_workers_ai");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      env.AI.run(BGE_RERANKER_MODEL as never, {
        query,
        top_k: items.length,
        contexts: items.map(it => ({ text: it.content.slice(0, RERANK_SNIPPET_CHARS) })),
      } as never) as Promise<{ response?: { id?: number; score?: number }[] }>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    const grades: (Grade | null)[] = items.map(() => null);
    for (const r of out?.response ?? []) {
      if (typeof r.id === "number" && r.id >= 0 && r.id < items.length && typeof r.score === "number" && Number.isFinite(r.score)) {
        // Cross-encoder relevance, already a probability-like score: fully trusted.
        grades[r.id] = { value: clamp01(r.score), confidence: 1 };
      }
    }
    return grades;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reorders `items` (already permission-filtered). Returns new scores keyed by id
 * when it ran; the caller applies them and re-sorts. Never throws.
 */
export async function rerankCandidates(
  env: Env,
  cfg: Readonly<Config>,
  query: string,
  items: readonly RerankInput[],
): Promise<{ scores: Map<string, number> | null; info: RerankInfo }> {
  const mode = rerankerMode(cfg);
  const started = performance.now();
  const done = (partial: Partial<RerankInfo> & { ran: boolean }, scores: Map<string, number> | null = null) => ({
    scores,
    info: { mode, ms: Math.round(performance.now() - started), candidates: items.length, ...partial } as RerankInfo,
  });
  if (mode === "off") return done({ ran: false });
  if (items.length < 2) return done({ ran: false, degraded: "too_few_candidates" });

  const pool = items.slice(0, Math.max(2, Math.min(30, Math.trunc(cfg.RERANKER_MAX_CANDIDATES))));
  try {
    const grades = mode === "jev"
      ? await gradeWithJev(env, query, pool, cfg.RERANKER_TIMEOUT_MS)
      : await gradeWithBge(env, query, pool, cfg.RERANKER_TIMEOUT_MS);
    if (!grades.some(g => g !== null)) throw new Error("no_grades");

    const best = Math.max(...pool.map(p => p.score), 0);
    const norm = (s: number) => (best > 0 ? s / best : 0);
    const weight = Math.min(1, Math.max(0, cfg.RERANKER_JEV_WEIGHT));
    const scores = new Map<string, number>();
    pool.forEach((it, i) => scores.set(it.id, blendScore(norm(it.score), grades[i], weight) * (best || 1)));
    // Candidates beyond the pool keep their relative place below it.
    const floor = Math.min(...scores.values());
    for (const it of items.slice(pool.length)) scores.set(it.id, Math.min(it.score, floor * 0.999));
    return done({ ran: true }, scores);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Ids and a reason only. Memory text never goes to the log.
    console.warn(JSON.stringify({ event: "reranker_degraded", mode, reason, candidates: items.length, ids: pool.map(p => p.id) }));
    return done({ ran: false, degraded: reason });
  }
}
