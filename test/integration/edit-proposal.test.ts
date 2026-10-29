/**
 * Proposta de edição de documento (PRD: membro propõe, owner vê o que mudou, aprova, vira nova versão):
 * preserva quebras de linha, guarda o texto antigo, respeita nível e papel, e o histórico só mostra o que a pessoa lê.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TOKENS, setupDemoWorld, type DemoWorld } from "../helpers/demo-seed";

let w: DemoWorld;
let owner: string;
beforeEach(async () => { w = await setupDemoWorld(); owner = (w.env as { AUTH_TOKEN: string }).AUTH_TOKEN; });
afterEach(() => w.close());
const j = async (r: Response) => (await r.json()) as any;

const DOC = "demo-dique-p12-planilha";
const NEW_TEXT = "# Planilha de metas do trimestre\nA meta de leads da Dique é de 950 por mês.\n\n## Revisão\n- Confirmada em reunião";

describe("propor edição", () => {
  it("membro propõe; o owner vê o texto atual para comparar e aprova; as quebras de linha ficam", async () => {
    const sent = await j(await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: DOC, content: NEW_TEXT }));
    expect(sent).toMatchObject({ ok: true, applied: false });
    expect(sent.owner.name).toBe("Demo Diretoria");

    const queue = await j(await w.call(owner, "GET", "/contributions?status=pending"));
    const item = queue.contributions.find((c: any) => c.id === sent.id);
    expect(item).toMatchObject({ reason: "edit-proposal", client_name: "Dique", submitter_name: "Demo Time" });
    expect(item.current_content).toContain("900 leads");
    expect(item.content).toBe(NEW_TEXT);

    const ok = await j(await w.call(owner, "POST", "/contributions/resolve", { id: sent.id, action: "approve" }));
    expect(ok).toMatchObject({ status: "approved", entry_id: DOC });

    const entry = (await j(await w.call(owner, "GET", `/entry?id=${DOC}`))).entry;
    expect(entry.content).toBe(NEW_TEXT);
    const versions = (await j(await w.call(owner, "GET", `/entry/versions?id=${DOC}`))).versions;
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toContain("900 leads");
    expect(versions[0].actor_name).toBeTruthy();
  });

  it("admin aplica na hora, com versão", async () => {
    const r = await j(await w.call(owner, "POST", "/entry/propose-edit", { id: DOC, content: NEW_TEXT }));
    expect(r).toMatchObject({ ok: true, applied: true });
    expect((await j(await w.call(owner, "GET", `/entry/versions?id=${DOC}`))).versions).toHaveLength(1);
  });

  it("nível: quem não lê o documento recebe 404, igual a um id que não existe", async () => {
    const p0 = await j(await w.call(owner, "GET", "/client/entries?client=demo-dir-aurora&level=0"));
    const hidden = (p0.entries as any[])[0].id;
    const real = await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: hidden, content: "x".repeat(20) });
    const fake = await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: "nao-existe", content: "x".repeat(20) });
    expect(real.status).toBe(404);
    expect(fake.status).toBe(404);
    expect(await real.text()).toBe((await fake.text()).replace("nao-existe", hidden));
  });

  it("quem não é dono do cliente nem admin não decide a proposta", async () => {
    const sent = await j(await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: DOC, content: NEW_TEXT }));
    // P6 é dono da Aurora, não da Dique
    expect((await j(await w.call(DEMO_TOKENS.p6, "GET", "/contributions?status=pending"))).contributions.some((c: any) => c.id === sent.id)).toBe(false);
    expect((await w.call(DEMO_TOKENS.p6, "POST", "/contributions/resolve", { id: sent.id, action: "approve" })).status).toBe(404);
  });

  it("nota privada não recebe proposta; texto igual ou vazio é recusado", async () => {
    const note = await j(await w.call(DEMO_TOKENS.p8, "POST", "/capture", { content: "Nota minha", workspace: "personal" }));
    expect((await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: note.id, content: "Outra versão da nota" })).status).toBe(400);
    expect((await w.call(DEMO_TOKENS.p8, "POST", "/entry/propose-edit", { id: DOC, content: "   " })).status).toBe(400);
  });

  it("o histórico não mostra versão com nível acima do de quem pergunta", async () => {
    await w.call(owner, "POST", "/entry/propose-edit", { id: DOC, content: NEW_TEXT });
    const mine = await j(await w.call(DEMO_TOKENS.p8, "GET", `/entry/versions?id=${DOC}`));
    expect(mine.ok).toBe(true);
    expect(mine.versions.every((v: any) => v.clearance_level >= 8)).toBe(true);
  });
});
