/**
 * API da interface redesenhada: página do cliente, ver como, sinalizar conflito, proposta de Canon.
 * Sobre o seed de demonstração. Foco: nada acima do nível chega por esses caminhos novos.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";

let w: DemoWorld;
let ownerToken: string;
beforeEach(async () => { w = await setupDemoWorld(); ownerToken = (w.env as { AUTH_TOKEN: string }).AUTH_TOKEN; });
afterEach(() => w.close());

const j = async (res: Response) => (await res.json()) as any;
const as = (token: string, personId: string, method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "X-View-As": personId, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), w.env, { waitUntil() {} } as unknown as ExecutionContext);

describe("GET /client/entries", () => {
  it("Canon em primeiro plano e fontes filtradas por nível", async () => {
    const canon = await j(await w.call(DEMO_TOKENS.p8, "GET", "/client/entries?client=demo-dir-dique&view=canon"));
    expect(canon.entries.map((e: any) => e.id)).toEqual(["demo-dique-p12-resumo"]);
    expect(canon.entries[0].review_state).toBe("verified");
    const src = await j(await w.call(DEMO_TOKENS.p8, "GET", "/client/entries?client=demo-dir-dique&view=sources"));
    const ids = src.entries.map((e: any) => e.id);
    expect(ids).not.toContain("demo-dique-p12-resumo");
    expect(ids).not.toContain("demo-dique-p0-margem");
    expect(ids).not.toContain("demo-dique-p6-escopo");
    const p0 = await j(await w.call(DEMO_TOKENS.p0, "GET", "/client/entries?client=demo-dir-dique&view=sources"));
    expect(p0.entries.map((e: any) => e.id)).toContain("demo-dique-p0-margem");
    const byLevel = await j(await w.call(DEMO_TOKENS.p0, "GET", "/client/entries?client=demo-dir-dique&view=sources&level=6"));
    expect(byLevel.entries.map((e: any) => e.id)).toEqual(["demo-dique-p6-escopo"]);
  });

  it("cliente inexistente responde 404", async () => {
    expect((await w.call(DEMO_TOKENS.p8, "GET", "/client/entries?client=nao-existe")).status).toBe(404);
  });
});

describe("ver como", () => {
  it("o admin vê exatamente o que a pessoa vê, pelo mesmo filtro do servidor", async () => {
    const q = "/recall?query=margem%20l%C3%ADquida%20do%20contrato&topK=10&full=1&client=demo-dir-dique";
    const real = await j(await w.call(DEMO_TOKENS.p8, "GET", q));
    const viewed = await j(await as(ownerToken, "demo-usr-p8", "GET", q));
    expect(viewed.results.map((r: any) => r.id)).toEqual(real.results.map((r: any) => r.id));
    expect(JSON.stringify(viewed)).not.toMatch(/31%|480 mil/);
    const adminOwn = await j(await w.call(ownerToken, "GET", q));
    expect(adminOwn.results.map((r: any) => r.id)).toContain("demo-dique-p0-margem");
  });

  it("é somente leitura e não abre portas de admin", async () => {
    const write = await as(ownerToken, "demo-usr-p8", "POST", "/canon/propose", { content: "x", client: "demo-dir-dique" });
    expect(write.status).toBe(403);
    const adminRoute = await as(ownerToken, "demo-usr-p8", "GET", "/team/members");
    expect(adminRoute.status).toBe(403);
    const me = await j(await as(ownerToken, "demo-usr-p8", "GET", "/permissions/me"));
    expect(me).toMatchObject({ name: "Demo Time", clearanceFloor: 8, viewAs: true });
  });

  it("só admin pode usar o header", async () => {
    const res = await as(DEMO_TOKENS.p6, "demo-usr-p0", "GET", "/permissions/me");
    expect(res.status).toBe(403);
  });
});

describe("sinalizar conflito e propor Canon", () => {
  it("sinaliza o par, devolve quem decide e registra uma sugestão aberta", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "POST", "/conflicts/flag", { a: "demo-dique-p12-ata", b: "demo-dique-p12-planilha" }));
    expect(r.ok).toBe(true);
    expect(r.owner.id).toBe("demo-usr-p6");
    const bad = await w.call(DEMO_TOKENS.p8, "POST", "/conflicts/flag", { a: "demo-dique-p12-ata", b: "demo-dique-p0-margem" });
    expect(bad.status).toBe(404);
  });

  it("proposta de Canon nasce no nível mais restrito das fontes e vai para a fila do owner", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p6, "POST", "/canon/propose", { content: "# Proposta\nResumo.", client: "demo-dir-dique", source_ids: ["demo-dique-p6-escopo", "demo-dique-p12-resumo"] }));
    expect(r).toMatchObject({ ok: true, level: 6 });
    expect(r.owner.name).toBe("Demo Diretoria");
    // O owner do cliente (P0) vê o item na fila; quem está abaixo do nível não vê nem o item nem sinal dele.
    const q0 = await j(await w.call(DEMO_TOKENS.p0, "GET", "/contributions?status=pending"));
    expect(q0.contributions.map((c: any) => c.id)).toContain(r.id);
    const q8 = await j(await w.call(DEMO_TOKENS.p8, "GET", "/contributions?status=pending"));
    expect(q8.contributions).toEqual([]);
    const approve = await j(await w.call(DEMO_TOKENS.p0, "POST", "/contributions/resolve", { id: r.id, action: "approve", level: 6 }));
    expect(approve.status).toBe("approved");
    const canon = await j(await w.call(DEMO_TOKENS.p6, "GET", "/client/entries?client=demo-dir-dique&view=canon"));
    expect(canon.entries.some((e: any) => e.content.startsWith("# Proposta"))).toBe(true);
    const canonP8 = await j(await w.call(DEMO_TOKENS.p8, "GET", "/client/entries?client=demo-dir-dique&view=canon"));
    expect(canonP8.entries.some((e: any) => e.content.startsWith("# Proposta"))).toBe(false);
  });

  it("proposta sem fontes legíveis cai no nível da própria pessoa; fonte ilegível não conta", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "POST", "/canon/propose", { content: "Nota", client: "demo-dir-dique", source_ids: ["demo-dique-p0-margem"] }));
    expect(r.level).toBe(8);
  });
});
