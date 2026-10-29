/**
 * Contribuir: a IA sugere, a pessoa confirma, o item entra na fila do owner do cliente. Auditoria de permissões.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";
import { parseSuggestion, suggestByRules } from "../../src/routes/contribute";

let w: DemoWorld;
let owner: string;
beforeEach(async () => { w = await setupDemoWorld(); owner = (w.env as { AUTH_TOKEN: string }).AUTH_TOKEN; });
afterEach(() => w.close());
const j = async (r: Response) => (await r.json()) as any;
const clients = [{ id: "demo-dir-dique", name: "Dique" }, { id: "demo-dir-aurora", name: "Aurora Têxtil" }];

describe("sugestão", () => {
  it("por regras: cliente mais citado, nível no piso de quem envia", () => {
    const s = suggestByRules("Reunião com a Dique. A Dique pediu relatório. Aurora não veio.", "ata-dique.md", clients, 8);
    expect(s).toMatchObject({ client: "demo-dir-dique", level: 8 });
    expect(suggestByRules("Texto solto sobre processos.", "", clients, 6).client).toBe("internal");
  });
  it("lê o JSON do modelo e recusa nível inválido ou cliente fora da lista", () => {
    expect(parseSuggestion('ok {"client":"aurora textil","level":5,"summary":"Resumo."}', clients)).toEqual({ client: "demo-dir-aurora", level: 5, summary: "Resumo." });
    expect(parseSuggestion('{"client":"Inventada","level":3,"summary":"x"}', clients)!.client).toBe("internal");
    expect(parseSuggestion('{"client":"Dique","level":99}', clients)).toBeNull();
    expect(parseSuggestion("sem json", clients)).toBeNull();
  });
  it("a rota responde com sugestão mesmo sem modelo útil", async () => {
    const r = await j(await w.call(DEMO_TOKENS.p8, "POST", "/contributions/suggest", { content: "Ata com a Dique sobre metas de leads.", filename: "ata.md" }));
    expect(r).toMatchObject({ ok: true, client: "demo-dir-dique", level: 8 });
  });
});

describe("enviar e revisar", () => {
  it("entra na fila do owner; aprovado, vira fonte do cliente no nível escolhido", async () => {
    const sent = await j(await w.call(DEMO_TOKENS.p8, "POST", "/contributions/submit", { content: "# Ata de setembro\nA Dique aprovou o novo funil.", filename: "ata-setembro.md", client: "demo-dir-dique", level: 8, summary: "Aprovação do funil." }));
    expect(sent).toMatchObject({ ok: true });
    expect(sent.owner.name).toBe("Demo Diretoria");
    const queue = await j(await w.call(DEMO_TOKENS.p0, "GET", "/contributions?status=pending"));
    const item = queue.contributions.find((c: any) => c.id === sent.id);
    expect(item).toMatchObject({ client_name: "Dique", submitter_name: "Demo Time", suggested_level: 8 });
    // ajustar o nível ao aprovar
    const ok = await j(await w.call(DEMO_TOKENS.p0, "POST", "/contributions/resolve", { id: sent.id, action: "approve", level: 6 }));
    expect(ok).toMatchObject({ status: "approved", level: 6 });
    const p8 = await j(await w.call(DEMO_TOKENS.p8, "GET", "/client/entries?client=demo-dir-dique&view=sources"));
    expect(p8.entries.some((e: any) => e.content.includes("novo funil"))).toBe(false);
    const p6 = await j(await w.call(DEMO_TOKENS.p6, "GET", "/client/entries?client=demo-dir-dique&view=sources"));
    expect(p6.entries.some((e: any) => e.content.includes("novo funil"))).toBe(true);
  });

  it("recusa com motivo e registra na trilha", async () => {
    const sent = await j(await w.call(DEMO_TOKENS.p8, "POST", "/contributions/submit", { content: "Texto fora de lugar.", client: "internal", level: 8 }));
    const rej = await j(await w.call(owner, "POST", "/contributions/resolve", { id: sent.id, action: "reject", motive: "Fora do escopo do cliente." }));
    expect(rej.status).toBe("rejected");
    await Promise.resolve();
    const audit = await j(await w.call(owner, "GET", "/admin/audit?group=all"));
    const ev = audit.events.find((e: any) => e.event === "contribution_rejected");
    expect(ev.payload.motive).toBe("Fora do escopo do cliente.");
  });

  it("cliente que a pessoa não alcança responde 404", async () => {
    const r = await w.call(DEMO_TOKENS.p8, "POST", "/contributions/submit", { content: "x", client: "nao-existe", level: 8 });
    expect(r.status).toBe(404);
  });
});

describe("auditoria de permissões", () => {
  it("só admin lê", async () => {
    expect((await w.call(DEMO_TOKENS.p8, "GET", "/admin/audit")).status).toBe(403);
    expect((await w.call(owner, "GET", "/admin/audit")).status).toBe(200);
  });
});
