/**
 * Funcionalidades da interface anterior que voltaram (Memórias, grafo, resumo, padrões, desatualizados, equipe, dados).
 * O que importa aqui é a regra do projeto: nada acima do nível de quem pergunta chega a nenhuma dessas telas,
 * nem como nó do grafo, nem como contagem, nem como trecho do resumo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";

let w: DemoWorld;
let owner: string;
beforeEach(async () => { w = await setupDemoWorld(); owner = (w.env as { AUTH_TOKEN: string }).AUTH_TOKEN; });
afterEach(() => w.close());
const j = async (r: Response) => (await r.json()) as any;

const P0_MARKERS = ["31%", "480 mil", "24%", "210 mil", "demo-dique-p0-margem", "demo-aurora-p0-margem"];
const leaks = (body: unknown) => P0_MARKERS.filter((m) => JSON.stringify(body).includes(m));

describe("grafo", () => {
  it("P0 vê as ligações com conteúdo P0; P8 não recebe o nó nem a aresta", async () => {
    const p0 = await j(await w.call(DEMO_TOKENS.p0, "GET", "/graph"));
    expect(p0.nodes.map((n: any) => n.id)).toContain("demo-dique-p0-margem");
    const p8 = await j(await w.call(DEMO_TOKENS.p8, "GET", "/graph"));
    expect(p8.nodes.length).toBeGreaterThan(0);
    expect(leaks(p8)).toEqual([]);
    const ids = new Set(p8.nodes.map((n: any) => n.id));
    for (const e of p8.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true); }
  });
});

describe("telas de memórias: nenhuma rota devolve conteúdo acima do nível", () => {
  it.each(["/list?n=100", "/brief", "/stale?limit=50", "/patterns?limit=50", "/tags", "/connections?id=demo-dique-p12-resumo", "/count"])("%s como P8", async (path) => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "GET", path));
    expect(leaks(r)).toEqual([]);
  });

  it("/connections não entrega a vizinha P0 a quem não a lê", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "GET", "/connections?id=demo-dique-p12-resumo"));
    expect((r.connections ?? []).some((c: any) => c.id === "demo-dique-p0-margem")).toBe(false);
    const p0 = await j(await w.call(DEMO_TOKENS.p0, "GET", "/connections?id=demo-dique-p12-resumo"));
    expect((p0.connections ?? []).some((c: any) => c.id === "demo-dique-p0-margem")).toBe(true);
  });

  it("contagens do resumo e do topo só contam o que a pessoa lê", async () => {
    const c0 = (await j(await w.call(DEMO_TOKENS.p0, "GET", "/count"))).count;
    const c8 = (await j(await w.call(DEMO_TOKENS.p8, "GET", "/count"))).count;
    expect(c8).toBeLessThan(c0);
    const b0 = await j(await w.call(DEMO_TOKENS.p0, "GET", "/brief"));
    const b8 = await j(await w.call(DEMO_TOKENS.p8, "GET", "/brief"));
    expect(b8.total).toBeLessThan(b0.total);
    expect(b8.total).toBe(c8);
  });

  it("o histórico do documento P0 responde 404 a P8", async () => {
    expect((await w.call(DEMO_TOKENS.p8, "GET", "/entry/versions?id=demo-dique-p0-margem")).status).toBe(404);
  });
});

describe("equipe, atividade e dados", () => {
  it("atividade e estatísticas só para admin; o roster todos leem sem e-mail", async () => {
    expect((await w.call(DEMO_TOKENS.p8, "GET", "/team/activity")).status).toBe(403);
    expect((await w.call(DEMO_TOKENS.p8, "GET", "/stats")).status).toBe(403);
    expect((await w.call(owner, "GET", "/team/activity")).status).toBe(200);
    const roster = await j(await w.call(DEMO_TOKENS.p8, "GET", "/team/roster"));
    expect(roster.ok).toBe(true);
    expect(JSON.stringify(roster)).not.toMatch(/@demo\.volanos\.invalid/);
  });

  it("exportar como P8 não leva conteúdo P0", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "GET", "/export"));
    expect(leaks(r)).toEqual([]);
  });

  it("restaurar um backup não escreve acima do nível de quem restaura", async () => {
    const payload = { version: 2, entries: [{ id: "bk-1", content: "Nota restaurada pelo P8", tags: [], source: "import", clearance_level: 0 }] };
    const res = await w.call(DEMO_TOKENS.p8, "POST", "/import", payload);
    expect(res.status).toBeLessThan(500);
    const seen = await j(await w.call(owner, "GET", "/entry?id=bk-1"));
    // Se entrou, entrou no workspace pessoal de quem restaurou e nunca em um nível mais restrito que o dele.
    if (seen.ok) expect(seen.entry.clearance_level === null || seen.entry.clearance_level >= 8).toBe(true);
  });
});
