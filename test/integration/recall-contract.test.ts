/**
 * Contrato do /recall para a interface "Perguntar": por fonte, client_id, author, updated_at,
 * clearance_level, review_state e stale; e um campo `conflicts` com pares de fontes divergentes.
 * Roda sobre o seed de demonstração (scripts/seed-demo-volanos.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";
import { ANSWER_PROMPT } from "../../src/recall/answer-prompt";

let w: DemoWorld;
beforeEach(async () => { w = await setupDemoWorld(); });
afterEach(() => w.close());

type Source = { id: string; client_id: string | null; author: string | null; updated_at: number; clearance_level: number; review_state: string | null; stale: boolean; content: string };
type Recall = { ok: boolean; results: Source[]; conflicts: { a: string; b: string; a_value: string; b_value: string; origin: string }[]; client: string | null };

async function recall(token: string, query: string, client?: string): Promise<Recall> {
  const q = `/recall?query=${encodeURIComponent(query)}&topK=10&full=1${client ? `&client=${encodeURIComponent(client)}` : ""}`;
  const res = await w.call(token, "GET", q);
  expect(res.status).toBe(200);
  return (await res.json()) as Recall;
}

describe("GET /recall: contrato por fonte", () => {
  it("devolve client_id, author, updated_at, clearance_level, review_state e stale em toda fonte", async () => {
    const r = await recall(DEMO_TOKENS.p8, "Dique", "demo-dir-dique");
    expect(r.results.length).toBeGreaterThan(3);
    for (const s of r.results) {
      expect(s.client_id).toBe("demo-dir-dique");
      expect(typeof s.updated_at).toBe("number");
      expect(Number.isInteger(s.clearance_level)).toBe(true);
      expect(typeof s.stale).toBe("boolean");
      expect("author" in s && "review_state" in s).toBe(true);
    }
    const byId = new Map(r.results.map((s) => [s.id, s]));
    expect(byId.get("demo-dique-p12-resumo")!.review_state).toBe("verified");
    expect(byId.get("demo-dique-p12-resumo")!.author).toBe("Demo Diretoria");
    expect(byId.get("demo-dique-p12-planilha")!.review_state).toBe("draft");
    expect(byId.get("demo-dique-p8-promessas")!.review_state).toBe("reviewed");
    expect(byId.get("demo-dique-p12-crm")!.review_state).toBeNull();
  });

  it("marca como stale só a fonte com mais de 180 dias", async () => {
    const r = await recall(DEMO_TOKENS.p8, "Dique", "demo-dir-dique");
    const stale = r.results.filter((s) => s.stale).map((s) => s.id);
    expect(stale).toEqual(["demo-dique-p12-crm"]);
  });

  it("devolve o par de metas que se contradizem em `conflicts`", async () => {
    const r = await recall(DEMO_TOKENS.p8, "meta de leads qualificados da Dique", "demo-dir-dique");
    const pair = r.conflicts.find((c) => [c.a, c.b].includes("demo-dique-p12-ata") && [c.a, c.b].includes("demo-dique-p12-planilha"));
    expect(pair).toBeTruthy();
    const values = [pair!.a_value, pair!.b_value].join(" ");
    expect(values).toMatch(/1\.200/);
    expect(values).toMatch(/900/);
  });

  it("só aponta conflito entre fontes que a pessoa recebeu", async () => {
    const r = await recall(DEMO_TOKENS.p8, "meta de leads qualificados", "demo-dir-aurora");
    const ids = new Set(r.results.map((s) => s.id));
    for (const c of r.conflicts) { expect(ids.has(c.a)).toBe(true); expect(ids.has(c.b)).toBe(true); }
    expect(r.conflicts).toEqual([]);
  });

  it("resposta vazia mantém a mesma forma", async () => {
    const r = await recall(DEMO_TOKENS.p8, "Dique", "demo-dir-inexistente");
    expect(r).toMatchObject({ ok: true, results: [], conflicts: [], client: "demo-dir-inexistente" });
  });
});

describe("GET /clients", () => {
  it("lista só clientes com conteúdo legível e conta só o que a pessoa lê", async () => {
    const res = await w.call(DEMO_TOKENS.p8, "GET", "/clients");
    const body = (await res.json()) as { clients: { id: string; name: string; sources: number; owner: { name: string } | null }[]; internal: { sources: number } };
    expect(body.clients.map((c) => c.name)).toEqual(["Aurora Têxtil", "Dique"]);
    // P8 lê: Dique P8 e P12 (promessas, resumo, ata, planilha, crm) = 5.
    expect(body.clients.find((c) => c.name === "Dique")!.sources).toBe(5);
    const p0 = (await (await w.call(DEMO_TOKENS.p0, "GET", "/clients")).json()) as typeof body;
    expect(p0.clients.find((c) => c.name === "Dique")!.sources).toBe(7);
    expect(body.internal.sources).toBeLessThan(p0.internal.sources);
  });
});

describe("prompt de resposta", () => {
  it("pede frase-resumo, citação em toda afirmação, não-encontrei, nada de conhecimento geral sem marca e fim sem pergunta", () => {
    expect(ANSWER_PROMPT).toMatch(/ONE direct sentence/);
    expect(ANSWER_PROMPT).toMatch(/Cite every claim/);
    expect(ANSWER_PROMPT).toMatch(/\[not-found\]/);
    expect(ANSWER_PROMPT).toMatch(/Never complete an answer with general knowledge/);
    expect(ANSWER_PROMPT).toMatch(/No closing question/);
  });
});
