import type { Env } from "../env";
import { CLEARANCE_MAX, CLEARANCE_MIN } from "../lib/permissions";

/**
 * The 13 clearance levels, in words. One text per level, used in three places:
 * the invite screen ("what does this level read?"), the admin editor, and the
 * Jev rubric. Keeping one source means the classifier and the people reading
 * the UI are talking about the same thing.
 *
 * Proposal for André to validate (PRD, "Os 13 níveis").
 */
export interface LevelText {
  level: number;
  /** Who usually holds this level. */
  holders: string;
  /** What only this level (and the ones above it) can read. */
  reads: string;
  example: string;
}

export const DEFAULT_LEVELS: readonly LevelText[] = [
  { level: 0, holders: "André (owner)", reads: "Desabafos sobre pessoas, conversas de sócio e investidor, sigilo pedido pelo fundador", example: "Valuation em negociação" },
  { level: 1, holders: "Sócios e diretoria", reads: "Estratégia não anunciada, portfólio, metas de margem", example: "Sair do varejo em 2027" },
  { level: 2, holders: "Liderança + RH", reads: "Salários, reajustes, avaliações, propostas a candidatos", example: "Reajuste de uma designer" },
  { level: 3, holders: "Liderança + finanças", reads: "Receita, margem, caixa, quanto cada cliente paga, questões fiscais", example: "Receita do Q3" },
  { level: 4, holders: "Líderes de conta", reads: "Segredos contados pelo cliente, limites de negociação", example: "Cliente vai vender uma unidade" },
  { level: 5, holders: "Time da conta", reads: "Dados do cliente sob NDA: métricas, listas, materiais internos", example: "Taxa de abertura da campanha" },
  { level: 6, holders: "Time comercial", reads: "Pipeline, tabela de preços de referência, processo de cobrança", example: "Preço base do Forge" },
  { level: 7, holders: "Todo o time", reads: "Processos, rituais, ferramentas, onboarding, decisões técnicas", example: "Como pedir uma ferramenta" },
  { level: 8, holders: "Time e prestadores fixos", reads: "Guias e políticas internas", example: "Política de uso de IA" },
  { level: 9, holders: "Freelancers de projeto", reads: "Brief, prazos e escopo de uma entrega", example: "Brief do motion" },
  { level: 10, holders: "Cliente da conta", reads: "Briefings, paleta e textos aprovados daquele cliente", example: "Paleta aprovada" },
  { level: 11, holders: "Parceiros e fornecedores", reads: "Método e informações institucionais sem dados de cliente", example: "Como funciona o Genesis" },
  { level: 12, holders: "Público", reads: "Site, posts, cases autorizados", example: "Posicionamento da Volanos" },
];

export const LEVELS_KV_KEY = "levels:texts";

/** Rules appended to the rubric. The first one carries the safety weight. */
export const RUBRIC_RULES: readonly string[] = [
  "Vale o nível mais restrito (menor número) que o trecho exige.",
  "Dinheiro da Volanos (receita, margem, caixa, quanto um cliente paga) nunca é mais aberto que P3.",
  "Informação pessoal sobre uma pessoa (salário, avaliação, saúde, conflito) nunca é mais aberta que P2.",
  "Algo que um cliente contou em confiança, ou que está sob NDA, nunca é mais aberto que P5.",
  "Só é P12 o que já é público: site, posts publicados, cases autorizados.",
];

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Merge stored overrides over the defaults. Unknown levels and bad types are dropped. */
export function mergeLevels(stored: unknown): LevelText[] {
  const byLevel = new Map<number, Partial<LevelText>>();
  if (Array.isArray(stored)) {
    for (const row of stored) {
      const level = Number((row as LevelText)?.level);
      if (Number.isInteger(level) && level >= CLEARANCE_MIN && level <= CLEARANCE_MAX) byLevel.set(level, row as LevelText);
    }
  }
  return DEFAULT_LEVELS.map(d => {
    const o = byLevel.get(d.level);
    return {
      level: d.level,
      holders: clean(o?.holders, 120) || d.holders,
      reads: clean(o?.reads, 500) || d.reads,
      example: clean(o?.example, 200) || d.example,
    };
  });
}

export async function getLevels(env: Env): Promise<LevelText[]> {
  try {
    const raw = await env.OAUTH_KV.get(LEVELS_KV_KEY);
    return mergeLevels(raw ? JSON.parse(raw) : null);
  } catch {
    return mergeLevels(null);
  }
}

export async function saveLevels(env: Env, rows: unknown): Promise<LevelText[]> {
  const merged = mergeLevels(rows);
  await env.OAUTH_KV.put(LEVELS_KV_KEY, JSON.stringify(merged));
  return merged;
}

/** The option map handed to Jev: one criterion per level. */
export function levelCriteria(levels: readonly LevelText[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of levels) out[`P${l.level}`] = `${l.reads}. Exemplo: ${l.example}. Quem costuma ler: ${l.holders}.`;
  return out;
}

export function rubricInstructions(): string {
  return [
    "Escolha o nível de acesso (P0 a P12) que o trecho indicado exige. P0 é o mais restrito, P12 é público.",
    ...RUBRIC_RULES.map((r, i) => `Regra ${i + 1}: ${r}`),
  ].join("\n");
}

export function parseLevel(option: string): number | null {
  const m = /^P(\d{1,2})$/.exec(option.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= CLEARANCE_MIN && n <= CLEARANCE_MAX ? n : null;
}
