import { extractEntities, extractFacts, sentences } from "./text";

/**
 * Extractive summary of a cold episodic note: no model, no rewriting. It keeps the
 * title and the sentences that carry what is hard to rebuild later (figures and
 * dates, decisions, file names, client and people names), in their original order
 * and original words. Everything else is left to the version history, where the
 * full original stays recoverable (`restore`).
 */

export const COMPACT_MARKER = "[Resumo extrativo de nota fria. O texto original está no histórico e pode ser restaurado]";
/** Notes shorter than this are not worth compacting. */
export const COMPACT_MIN_CHARS = 700;
const TARGET_RATIO = 0.4;
const MAX_CHARS = 900;

const DECISION = /\b(decid\w*|decis[aã]o|decisões|aprov\w*|defini\w*|acord\w*|fechad\w*|combinad\w*|ficou\s+(?:definido|combinado|decidido)|vamos|ser[aá]|decided|approved|agreed|will|must|deadline|prazo|due)\b/i;
const FILE = /\b[\w-]+\.(?:md|pdf|docx?|xlsx?|pptx?|csv|json|ts|js|py|png|jpg|zip)\b/i;
const CLIENT = /\b(?:cliente|client|customer|parceiro|partner|fornecedor|vendor|contrato|contract)\b/i;

export interface ScoredSentence { text: string; index: number; score: number }

export function scoreSentence(s: string): number {
  let score = 0;
  const facts = extractFacts(s);
  if (facts.some(f => f.kind === "num")) score += 3;
  if (facts.some(f => f.kind === "date")) score += 3;
  if (DECISION.test(s)) score += 3;
  if (FILE.test(s)) score += 2;
  if (CLIENT.test(s)) score += 2;
  score += Math.min(3, extractEntities(s).size);
  return score;
}

export function isAlreadyCompacted(content: string): boolean {
  return content.startsWith(COMPACT_MARKER);
}

/** Null when the note is too short to bother, or when no useful sentence was found. */
export function extractiveSummary(content: string): string | null {
  if (content.length < COMPACT_MIN_CHARS || isAlreadyCompacted(content)) return null;
  const lines = content.split("\n");
  const titleLine = lines.find(l => l.trim()) ?? "";
  const title = titleLine.trim();
  const rest = content.slice(content.indexOf(titleLine) + titleLine.length);
  const all: ScoredSentence[] = sentences(rest).map((text, index) => ({ text, index, score: scoreSentence(text) }));
  const informative = all.filter(s => s.score > 0);
  if (!informative.length) return null;

  const budget = Math.min(MAX_CHARS, Math.max(200, Math.floor(content.length * TARGET_RATIO)));
  const chosen: ScoredSentence[] = [];
  let used = title.length;
  for (const s of [...informative].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (used + s.text.length + 1 > budget && chosen.length >= 1) continue;
    chosen.push(s);
    used += s.text.length + 1;
  }
  chosen.sort((a, b) => a.index - b.index);
  const summary = `${COMPACT_MARKER}\n\n${title}\n${chosen.map(s => s.text).join("\n")}`;
  // A summary that is not clearly shorter would only churn the version history.
  return summary.length < content.length * 0.75 ? summary : null;
}
