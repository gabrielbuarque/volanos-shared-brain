/**
 * The demo seed (scripts/seed-demo-volanos.mjs) loads into a real-SQLite brain
 * and the permission filter holds with it in place: the same question about
 * Dique returns the P0 passage to a P0 account and nothing of it, nor any sign
 * that it exists, to a P8 account.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";

let w: DemoWorld;
beforeEach(async () => { w = await setupDemoWorld(); });
afterEach(() => w.close());

const recall = async (token: string, query: string, client?: string) => {
  const res = await w.call(token, "GET", `/recall?query=${encodeURIComponent(query)}&topK=10&full=1${client ? `&client=${client}` : ""}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { results: { id: string; content: string }[]; message?: string };
};

describe("demo seed", () => {
  it("covers two clients, P0, P6 and P12, a contradiction and a source older than 180 days", async () => {
    const rows = (await w.sqlite.db.prepare(`SELECT id, clearance_level AS lvl, directory_id AS dir, updated_at AS u FROM entries WHERE id LIKE 'demo-%'`).all()).results as { id: string; lvl: number; dir: string | null; u: number }[];
    expect(new Set(rows.map((r) => r.dir))).toEqual(new Set(["demo-dir-dique", "demo-dir-aurora", null]));
    for (const lvl of [0, 6, 12]) expect(rows.some((r) => r.lvl === lvl && r.dir === "demo-dir-dique")).toBe(true);
    expect(rows.some((r) => Date.now() - r.u > 180 * 86_400_000)).toBe(true);
    const c = (await w.sqlite.db.prepare(`SELECT COUNT(*) AS n FROM aging_suggestions WHERE kind = 'contradiction'`).first()) as { n: number };
    expect(c.n).toBe(1);
  });

  it("gives P0 the restricted passage and gives P8 neither it nor a trace of it", async () => {
    const q = "margem líquida do contrato Dique";
    const asP0 = await recall(DEMO_TOKENS.p0, q);
    expect(asP0.results.map((r) => r.id)).toContain("demo-dique-p0-margem");

    const asP8 = await recall(DEMO_TOKENS.p8, q);
    const body = JSON.stringify(asP8);
    expect(body).not.toContain("demo-dique-p0-margem");
    expect(body).not.toContain("31%");
    expect(body).not.toContain("480 mil");
    // A question only the P0 passage answers looks exactly like a question nobody can answer.
    const nothing = await recall(DEMO_TOKENS.p8, "xyzzy plugh inexistente");
    expect(asP8.results.filter((r) => r.id === "demo-dique-p0-margem")).toHaveLength(0);
    expect(asP8.message).toBe(nothing.message);
    expect(Object.keys(asP8).sort()).toEqual(Object.keys(nothing).sort());
  });

  it("mesma pergunta sobre a Dique: P0 recebe o trecho P0, P8 não recebe nem sinal dele", async () => {
    const q = "margem líquida do contrato";
    const p0 = await recall(DEMO_TOKENS.p0, q, "demo-dir-dique");
    expect(p0.results.map((r) => r.id)).toContain("demo-dique-p0-margem");
    const p8 = await recall(DEMO_TOKENS.p8, q, "demo-dir-dique");
    const raw = JSON.stringify(p8);
    expect(p8.results.map((r) => r.id)).not.toContain("demo-dique-p0-margem");
    expect(raw).not.toMatch(/31%|480 mil|margem-dique|restrit/i);
    expect(p8.results.every((r) => r.id.startsWith("demo-dique"))).toBe(true);
  });

  it("trocar para o outro cliente não traz nada da Dique, em nenhum nível", async () => {
    for (const token of [DEMO_TOKENS.p0, DEMO_TOKENS.p8]) {
      const r = await recall(token, "meta de leads margem contrato resumo Dique", "demo-dir-aurora");
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results.every((x) => x.id.startsWith("demo-aurora"))).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/Dique|1.200|900 leads/);
    }
  });

  it("keeps the model prompts free of text above the asker's level", async () => {
    const res = await w.call(DEMO_TOKENS.p8, "POST", "/chat", { query: "margem do contrato Dique", memories: "1. [x] sem trecho", memory_ids: ["demo-dique-p0-margem"] });
    await res.text();
    expect(w.prompts.join("\n")).not.toContain("31%");
  });
});
