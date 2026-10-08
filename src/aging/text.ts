/**
 * Text analysis for memory aging. Pure functions, no model, no network: the
 * weekly jobs must be cheap, repeatable and explainable ("these two sentences say
 * 4.2M and 5M about the same thing"), and the same input always gives the same
 * answer.
 */

export interface Fact {
  kind: "num" | "date";
  /** Normalised value: a number string ("4200000", "12%") or an ISO-ish date ("2026-03-12", "--03-12"). */
  key: string;
  raw: string;
}

const MONTHS: Record<string, string> = {
  janeiro: "01", jan: "01", january: "01", fevereiro: "02", fev: "02", february: "02", feb: "02",
  marco: "03", "março": "03", mar: "03", march: "03", abril: "04", abr: "04", april: "04", apr: "04",
  maio: "05", mai: "05", may: "05", junho: "06", jun: "06", june: "06", julho: "07", jul: "07", july: "07",
  agosto: "08", ago: "08", august: "08", aug: "08", setembro: "09", set: "09", september: "09", sep: "09",
  outubro: "10", out: "10", october: "10", oct: "10", novembro: "11", nov: "11", november: "11",
  dezembro: "12", dez: "12", december: "12", dec: "12",
};

const pad = (n: string | number): string => String(n).padStart(2, "0");

/** "1.200,50" -> 1200.5; "1,200.50" -> 1200.5; "4,2" -> 4.2; "1.200" -> 1200 (thousands, pt-BR). */
export function parseNumber(token: string): number | null {
  const t = token.trim();
  if (!/^\d[\d.,]*$/.test(t)) return null;
  let s = t;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else if (/^\d+\.\d+$/.test(s)) { /* plain decimal */ }
  else s = s.replace(/[.,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, mm: 1e6, milhao: 1e6, "milhão": 1e6, milhoes: 1e6, "milhões": 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bi: 1e9, bilhao: 1e9, "bilhão": 1e9, bilhoes: 1e9, "bilhões": 1e9, billion: 1e9,
};

/** Small counts only matter when they carry a unit: "30 dias" vs "45 days" is a conflict, "2 pessoas" next to "3 pessoas" in another sentence is noise we still catch as a unit figure. */
const UNIT_WORDS = /^(dias?|days?|horas?|hours?|hrs?|semanas?|weeks?|mes(es)?|months?|anos?|years?|usuarios?|usu[aá]rios?|users?|clientes?|customers?|reais|real|dolares|d[oó]lares|dollars?|euros?|licen[cç]as?|seats?|unidades|units)$/i;

const DATE_RES: { re: RegExp; to: (m: RegExpExecArray) => string | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, to: m => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, to: m => (Number(m[2]) <= 12 ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null) },
  { re: /\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g, to: m => (Number(m[2]) <= 12 && Number(m[1]) <= 31 ? `--${pad(m[2])}-${pad(m[1])}` : null) },
  {
    re: /\b(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ú]{3,9})(?:\s+(?:de\s+)?(\d{4}))?\b/g,
    to: m => {
      const month = MONTHS[m[2].toLowerCase()];
      if (!month) return null;
      return m[3] ? `${m[3]}-${month}-${pad(m[1])}` : `--${month}-${pad(m[1])}`;
    },
  },
];

export function extractFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  const consumed: [number, number][] = [];
  const overlaps = (s: number, e: number) => consumed.some(([a, b]) => s < b && e > a);

  for (const { re, to } of DATE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const key = to(m);
      if (!key || overlaps(m.index, m.index + m[0].length)) continue;
      consumed.push([m.index, m.index + m[0].length]);
      facts.push({ kind: "date", key: `D:${key}`, raw: m[0] });
    }
  }

  const numRe = /(R\$|US\$|\$|€|£)?\s?(\d[\d.,]*\d|\d)(?:\s?(%|[A-Za-zÀ-ú]{1,9}))?/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const base = parseNumber(m[2]);
    if (base === null) continue;
    const suffix = (m[3] ?? "").toLowerCase();
    let value = base;
    let unit = "";
    if (suffix === "%") unit = "%";
    else if (suffix in MULTIPLIERS) value = base * MULTIPLIERS[suffix];
    // A bare small integer glued to a word ("2 pessoas", "v2", "P7") is a count or a name, not a figure to compare.
    const currency = m[1] ?? "";
    const isFigure = currency !== "" || unit === "%" || suffix in MULTIPLIERS || base >= 100 || /[.,]/.test(m[2]) || UNIT_WORDS.test(suffix);
    if (!isFigure) continue;
    // The match may begin on the optional space before the digits, so look at the character before the digits themselves.
    const prev = text[start + m[0].indexOf(m[2], (m[1] ?? "").length) - 1];
    if (prev && /[A-Za-z]/.test(prev) && !currency) continue; // "v2", "P7", "abc123"
    facts.push({ kind: "num", key: `${currency.replace(/\s/g, "")}${Number.isInteger(value) ? value : Number(value.toFixed(6))}${unit}`, raw: m[0].trim() });
  }
  return facts;
}

const STOP = new Set(("a o os as um uma de da do das dos em no na nos nas por para com sem que e é ou se ao à the of to in on for and is are was were be by with at from as it this that an or not será foi são tem têm ter").split(" "));

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9#\-*])|\n+/).map(s => s.trim()).filter(s => s.length > 3);
}

function wordSet(sentence: string): Set<string> {
  const words = sentence.toLowerCase().replace(/[\d.,%$€£]+/g, " ").split(/[^a-zà-ú]+/).filter(w => w.length >= 3 && !STOP.has(w));
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Divergence {
  a: string;
  b: string;
  aValues: string[];
  bValues: string[];
  /** How much the two sentences otherwise agree (0–1). */
  overlap: number;
}

const snippet = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

/**
 * Pairs of sentences that say the same thing (their words agree) but carry
 * different figures or dates. One entry per sentence of A at most.
 */
export function findDivergences(a: string, b: string, minOverlap = 0.5): Divergence[] {
  const sb = sentences(b).map(s => ({ s, words: wordSet(s), facts: extractFacts(s) })).filter(x => x.facts.length);
  const out: Divergence[] = [];
  for (const sa of sentences(a)) {
    const factsA = extractFacts(sa);
    if (!factsA.length) continue;
    const wa = wordSet(sa);
    let best: { x: (typeof sb)[number]; j: number } | null = null;
    for (const x of sb) {
      const j = jaccard(wa, x.words);
      if (j >= minOverlap && (!best || j > best.j)) best = { x, j };
    }
    if (!best) continue;
    const ka = new Set(factsA.map(f => f.key));
    const kb = new Set(best.x.facts.map(f => f.key));
    const onlyA = factsA.filter(f => !kb.has(f.key));
    const onlyB = best.x.facts.filter(f => !ka.has(f.key));
    if (onlyA.length && onlyB.length) {
      out.push({ a: snippet(sa), b: snippet(best.x.s), aValues: onlyA.map(f => f.raw), bValues: onlyB.map(f => f.raw), overlap: Math.round(best.j * 100) / 100 });
    }
  }
  return out;
}

const SYSTEM_TAG = /^(status:|kind:|volatility:|stale:|capsule|rolled-up|synthesized|auto-|duplicate-candidate|contradiction|compacted|bulk-ingest|approved|doc:|source:)/;
export const topicTags = (tags: readonly string[]): string[] => tags.filter(t => !SYSTEM_TAG.test(t)).map(t => t.toLowerCase());

const NOT_ENTITY = new Set(("janeiro fevereiro março marco abril maio junho julho agosto setembro outubro novembro dezembro monday tuesday wednesday thursday friday saturday sunday segunda terça terca quarta quinta sexta sábado sabado domingo january february march april june july august september october november december the this that these those para com sem mas porque quando como onde também then there here").split(" "));

/** Capitalised names, camelCase names and file names, lowercased. Sentence-initial words are skipped unless they look like names. */
export function extractEntities(text: string): Set<string> {
  const out = new Set<string>();
  for (const s of sentences(text)) {
    const words = s.split(/\s+/);
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, "").replace(/\.+$/, "");
      if (w.length < 3) return;
      const lower = w.toLowerCase();
      if (NOT_ENTITY.has(lower)) return;
      if (/^[\w-]+\.(md|pdf|docx?|xlsx?|pptx?|csv|json|ts|js|py|png|jpg)$/i.test(w)) { out.add(lower); return; }
      if (/^(?:\p{Lu}[\p{L}\p{N}]*\p{Ll}\p{Lu}|\p{Ll}+\p{Lu})/u.test(w)) { out.add(lower); return; } // camelCase / iPhone / ProductNames
      if (i > 0 && /^\p{Lu}\p{Ll}{2,}/u.test(w)) out.add(lower);
    });
  }
  return out;
}

export function sharedSubject(
  a: { tags: readonly string[]; content: string },
  b: { tags: readonly string[]; content: string },
): { tags: string[]; entities: string[] } {
  const tb = new Set(topicTags(b.tags));
  const tags = topicTags(a.tags).filter(t => tb.has(t));
  const eb = extractEntities(b.content);
  const entities = [...extractEntities(a.content)].filter(e => eb.has(e));
  return { tags: [...new Set(tags)], entities };
}
