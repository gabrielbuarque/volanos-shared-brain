import { describe, expect, it } from "vitest";
import { extractEntities, extractFacts, findDivergences, parseNumber, sentences, sharedSubject, topicTags } from "../../src/aging/text";
import { COMPACT_MARKER, extractiveSummary, scoreSentence } from "../../src/aging/compact";
import { decidePrecedence, sourceAuthority } from "../../src/aging/jobs";

const keys = (t: string) => extractFacts(t).map(f => f.key);

describe("figures and dates", () => {
  it("reads pt-BR and en numbers the same way", () => {
    expect(parseNumber("1.200,50")).toBe(1200.5);
    expect(parseNumber("1,200.50")).toBe(1200.5);
    expect(parseNumber("4,2")).toBe(4.2);
    expect(parseNumber("1.200")).toBe(1200);
  });

  it("normalises currency, percent, multipliers and units; ignores names that merely contain digits", () => {
    expect(keys("O orçamento é R$ 4,2 milhões")).toEqual(["R$4200000"]);
    expect(keys("Budget is 4.2M")).toEqual(["4200000"]);
    expect(keys("Churn caiu para 12%")).toEqual(["12%"]);
    expect(keys("Prazo de 30 dias")).toEqual(["30"]);
    expect(keys("Reunião do time P7 na v2 do Q3")).toEqual([]);
  });

  it("normalises dates to one spelling", () => {
    expect(keys("Entrega em 12/03/2026")).toEqual(["D:2026-03-12"]);
    expect(keys("Entrega em 2026-03-12")).toEqual(["D:2026-03-12"]);
    expect(keys("Entrega em 12 de março de 2026")).toEqual(["D:2026-03-12"]);
    expect(keys("Entrega em 12 de março")).toEqual(["D:--03-12"]);
  });
});

describe("divergences", () => {
  it("flags the same statement carrying a different figure or date", () => {
    const a = "O orçamento aprovado do projeto Atlas é R$ 4,2 milhões. O kickoff será em 10/03/2026.";
    const b = "O orçamento aprovado do projeto Atlas é R$ 5 milhões. O kickoff será em 10/03/2026.";
    const d = findDivergences(a, b);
    expect(d).toHaveLength(1);
    expect(d[0].aValues).toEqual(["R$ 4,2 milhões"]);
    expect(d[0].bValues).toEqual(["R$ 5 milhões"]);
  });

  it("does not flag agreement, a different topic, or a sentence with no figure", () => {
    expect(findDivergences("O orçamento do Atlas é R$ 4,2 milhões.", "O orçamento do Atlas é R$ 4,2 milhões, aprovado.")).toEqual([]);
    expect(findDivergences("O orçamento do Atlas é R$ 4,2 milhões.", "A equipe de marketing contratou 12 pessoas em março de 2026.")).toEqual([]);
    expect(findDivergences("O orçamento do Atlas é alto.", "O orçamento do Atlas é R$ 5 milhões.")).toEqual([]);
  });

  it("needs the same subject: shared topic tags or shared entities", () => {
    const a = { tags: ["pricing", "status:canonical", "kind:semantic"], content: "Cliente Acme assinou o contrato Atlas." };
    const b = { tags: ["Pricing", "auto-insight"], content: "A Acme revisou o Atlas." };
    expect(topicTags(a.tags)).toEqual(["pricing"]);
    const s = sharedSubject(a, b);
    expect(s.tags).toEqual(["pricing"]);
    expect(s.entities).toEqual(expect.arrayContaining(["acme", "atlas"]));
    expect(sharedSubject({ tags: [], content: "Texto solto sem nomes." }, { tags: [], content: "Outro texto qualquer." })).toEqual({ tags: [], entities: [] });
    expect([...extractEntities("Fechamos com a Acme. Veja plano.pdf e o iPhone.")]).toEqual(expect.arrayContaining(["acme", "plano.pdf", "iphone"]));
  });
});

describe("precedence (PRD: owner's canonical > source authority > recency > corroboration)", () => {
  const m = (id: string, over: Partial<{ tags: string[]; source: string; actor_id: string; ts: number }> = {}) =>
    ({ id, tags: [] as string[], source: "api", actor_id: `author-${id}`, ts: 1000, ...over });

  it("a canonical memory wins, and its author gets the alert", () => {
    expect(decidePrecedence(m("a", { tags: ["status:canonical"] }), m("b", { ts: 9999, source: "github" })))
      .toEqual({ winner: "a", rule: "canonical", owner: "author-a" });
  });

  it("corroboration can never dethrone a canonical", () => {
    const p = decidePrecedence(m("a", { tags: ["status:canonical"] }), m("b"), { a: 0, b: 50 });
    expect(p.winner).toBe("a");
    expect(p.rule).toBe("canonical");
  });

  it("two canonicals are a human decision", () => {
    expect(decidePrecedence(m("a", { tags: ["status:canonical"] }), m("b", { tags: ["status:canonical"] }))).toEqual({ winner: null, rule: "both-canonical", owner: "" });
  });

  it("without a canonical: source authority, then recency, then corroboration", () => {
    expect(sourceAuthority("github")).toBeGreaterThan(sourceAuthority("api"));
    expect(decidePrecedence(m("a", { source: "api", ts: 9 }), m("b", { source: "github", ts: 1 })).rule).toBe("source");
    expect(decidePrecedence(m("a", { ts: 9 }), m("b", { ts: 1 }))).toMatchObject({ winner: "a", rule: "recency" });
    expect(decidePrecedence(m("a"), m("b"), { a: 1, b: 3 })).toMatchObject({ winner: "b", rule: "corroboration" });
    expect(decidePrecedence(m("a"), m("b"))).toMatchObject({ winner: null, rule: "none" });
  });
});

describe("extractive summary of a cold note", () => {
  const note = [
    "# Reunião com a Acme sobre o contrato Atlas",
    "Todos chegaram no horário e o café estava ótimo. Falamos um pouco sobre o clima e sobre o fim de semana prolongado.",
    "Decidimos aprovar o orçamento de R$ 4,2 milhões para o projeto Atlas.",
    "A conversa seguiu sobre assuntos gerais, sem nada a registrar, durante um bom tempo, com várias pessoas comentando outros temas do dia.",
    "O kickoff ficou marcado para 10/03/2026 e o plano está em plano-atlas.pdf.",
    "Depois disso o grupo seguiu para o almoço e a reunião foi encerrada sem outras observações relevantes, com todos voltando às suas mesas.",
    "Ficou combinado que o cliente envia o contrato assinado até 15/03/2026.",
    "Mais um parágrafo de conversa solta, sem números, sem datas, sem decisões e sem nomes de arquivos, só para dar volume ao texto original da nota.",
  ].join("\n") + "\n" + "Enchimento de conversa sem importância. ".repeat(12);

  it("keeps the title and the sentences with figures, dates, decisions and files; drops the chatter; uses the original words", () => {
    const s = extractiveSummary(note)!;
    expect(s.startsWith(COMPACT_MARKER)).toBe(true);
    expect(s).toContain("# Reunião com a Acme sobre o contrato Atlas");
    expect(s).toContain("Decidimos aprovar o orçamento de R$ 4,2 milhões para o projeto Atlas.");
    expect(s).toContain("plano-atlas.pdf");
    expect(s).toContain("15/03/2026");
    expect(s).not.toContain("café estava ótimo");
    expect(s.length).toBeLessThan(note.length * 0.75);
  });

  it("is deterministic, leaves short or already compacted notes alone, and scores informative sentences higher", () => {
    expect(extractiveSummary(note)).toBe(extractiveSummary(note));
    expect(extractiveSummary("curta")).toBeNull();
    expect(extractiveSummary(extractiveSummary(note)! + "x".repeat(800))).toBeNull();
    expect(scoreSentence("Decidimos fechar em 10/03/2026 por R$ 5 milhões.")).toBeGreaterThan(scoreSentence("Conversa solta."));
    expect(sentences("Primeira frase. Segunda frase!\nTerceira").length).toBeGreaterThanOrEqual(3);
  });
});
