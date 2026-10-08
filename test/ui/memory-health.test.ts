/**
 * The admin tabs "Saúde da memória" and "Exportação" (public/js/memory-health.js).
 *
 * Same fake-DOM + vm approach as the other UI tests. What is pinned here is what a
 * person reads and what could hurt them: every memory text is escaped, the P0
 * warning is on the export tab, the switches and buttons call the right endpoints,
 * and a failing request is shown instead of swallowed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = readFileSync(resolve(ROOT, "public/js/memory-health.js"), "utf8");
const UTILS = readFileSync(resolve(ROOT, "public/utils.js"), "utf8");

interface Harness { ctx: any; calls: { path: string; init?: any }[]; panels: Map<string, { innerHTML: string; hidden?: boolean }>; toasts: string[] }

function setup(reply: (path: string, init?: any) => any): Harness {
  const panels = new Map<string, { innerHTML: string; hidden?: boolean; classList: any; setAttribute: () => void; value?: string }>();
  const calls: { path: string; init?: any }[] = [];
  const toasts: string[] = [];
  const el = (id: string) => {
    if (!panels.has(id)) panels.set(id, { innerHTML: "", classList: { toggle() {} }, setAttribute() {}, value: "" });
    return panels.get(id)!;
  };
  const ctx: any = {
    document: { getElementById: el },
    showToast: (m: string) => toasts.push(m),
    volPill: (n: number) => `<span class="lvl-pill">P${n}</span>`,
    volWhen: (ms: number) => `t${ms}`,
    volApi: async (path: string, init?: any) => {
      calls.push({ path, init });
      const r = reply(path, init);
      if (r instanceof Error) throw r;
      return r;
    },
    openDangerConfirm: () => {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(UTILS, ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, calls, panels: panels as never, toasts };
}

const health = {
  ok: true, flags: { dedup: true, contradictions: false, compact: false }, cold_days: 180,
  health: { duplicates_open: 1, contradictions_open: 1, cold_memories: 12, compactable_notes: 3, compacted: 2, superseded: 4, archived: 5, most_used: [{ id: "m1", title: "Plano <b>Atlas</b>", access_count: 9 }] },
  jobs: [{ id: "j1", job: "aging-dedup", actor_id: "system:aging-dedup", started_at: 1, finished_at: 2, ok: 1, summary: { scanned: 25, created: 1 } }, { id: "j2", job: "export", actor_id: "system:export", started_at: 3, finished_at: 4, ok: 0, summary: { error: "push refused" } }],
};
const side = (id: string, title: string, level: number, excerpt = "texto") => ({ id, title, excerpt, clearance_level: level, actor_id: "u", source: "api", version: 2, canonical: id === "a", updated_at: 5 });
const dup = { id: "s1", kind: "duplicate", status: "open", score: 0.97, owner_id: "u", created_at: 1, detail: {}, a: side("a", "A <img src=x onerror=alert(1)>", 7, "<script>alert('x')</script>"), b: side("b", "B", 7) };
const contra = { id: "s2", kind: "contradiction", status: "open", score: 0.9, owner_id: "u", created_at: 1, a: side("a", "A", 7), b: side("b", "B", 7), detail: { divergences: [{ aValues: ["R$ 4,2 milhões"], bValues: ["R$ 5 milhões"] }], precedence: { winner: "a", rule: "canonical" } } };

const answer = (path: string) => {
  if (path === "/admin/memory-health") return health;
  if (path.startsWith("/memory/suggestions?kind=duplicate")) return { ok: true, suggestions: [dup] };
  if (path.startsWith("/memory/suggestions?kind=contradiction")) return { ok: true, suggestions: [contra] };
  return { ok: true };
};

describe("Saúde da memória", () => {
  it("shows the counters, the three weekly switches, the open suggestions and the latest jobs", async () => {
    const h = setup(answer);
    await h.ctx.volRenderHealth();
    const html = h.panels.get("vol-panel-health")!.innerHTML;
    for (const text of ["duplicatas sugeridas", "contradições abertas", "memórias frias (180+ dias)", "Quase-duplicatas", "Contradições", "Compactação de notas frias", "Duplicatas para decidir", "Contradições abertas", "Últimas rotinas"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain("R$ 4,2 milhões");
    expect(html).toContain("canonical");
    expect(html).toContain("system:aging-dedup");
    expect(html).toContain("push refused");
    // dedup is on, so its button turns it off and "Rodar agora" is enabled; the others are off.
    expect(html).toContain("volSetAging('AGING_DEDUP', false)");
    expect(html).toContain("volSetAging('AGING_COMPACT', true)");
    expect(html).toMatch(/<button[^>]*disabled[^>]*onclick="volRunAging\('compact'\)"/);
  });

  it("escapes every memory text it renders", async () => {
    const h = setup(answer);
    await h.ctx.volRenderHealth();
    const html = h.panels.get("vol-panel-health")!.innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Atlas</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("states a failure instead of leaving the tab blank", async () => {
    const h = setup(() => new Error("Forbidden"));
    await h.ctx.volRenderHealth();
    expect(h.panels.get("vol-panel-health")!.innerHTML).toContain("Forbidden");
  });

  it("calls the endpoints the server defines: switch on, run, merge keeping one side, dismiss", async () => {
    const h = setup(answer);
    await h.ctx.volSetAging("AGING_COMPACT", true);
    await h.ctx.volRunAging("dedup");
    await h.ctx.volResolveSuggestion("s1", "merge", "a");
    await h.ctx.volResolveSuggestion("s1", "dismiss");
    const sent = h.calls.filter(c => c.init?.method);
    expect(sent.map(c => `${c.init.method} ${c.path}`)).toEqual([
      "PATCH /config", "POST /admin/aging/run", "POST /memory/suggestions/resolve", "POST /memory/suggestions/resolve",
    ]);
    expect(JSON.parse(sent[0].init.body)).toEqual({ AGING_COMPACT: "on" });
    expect(JSON.parse(sent[1].init.body)).toEqual({ job: "dedup" });
    expect(JSON.parse(sent[2].init.body)).toEqual({ id: "s1", action: "merge", keep: "a" });
    expect(JSON.parse(sent[3].init.body).action).toBe("dismiss");
  });
});

describe("Exportação", () => {
  const status = { ok: true, enabled: true, repo: "volanos/brain-export", branch: "main", token_configured: true, last_run_at: 7, last_message: "export: 3 novas, 1 alteradas, 0 arquivadas", schedule: "diário, 06:30 UTC (03:30 America/Fortaleza)", runs: [] };
  const exportReply = (path: string) => path === "/admin/export/status" ? status : path === "/config" ? { ok: true, config: { EXPORT_REPO: "volanos/brain-export", EXPORT_BRANCH: "main" } } : { ok: true };

  it("says in plain words that access to the repository equals P0 and who may have it", async () => {
    const h = setup(exportReply);
    await h.ctx.volRenderExport();
    const html = h.panels.get("vol-panel-export")!.innerHTML;
    expect(html).toContain("contém P0");
    expect(html).toContain("equivale a P0");
    expect(html).toContain("dono e ao admin técnico");
    expect(html).toContain("Exportar agora");
    expect(html).toContain("03:30 America/Fortaleza");
  });

  it("disables the buttons until a repository and token exist", async () => {
    const h = setup((path) => path === "/admin/export/status" ? { ...status, enabled: false, token_configured: false } : exportReply(path));
    await h.ctx.volRenderExport();
    const html = h.panels.get("vol-panel-export")!.innerHTML;
    expect(html).toMatch(/id="vol-export-now" disabled/);
    expect(html).toContain("GITHUB_EXPORT_TOKEN");
  });

  it("exports now, and walks a rebuild slice by slice, simulation first", async () => {
    let page = 0;
    const h = setup((path, init) => {
      if (path === "/admin/export-now") return { ok: true, status: "committed", message: "export: 1 novas, 0 alteradas, 0 arquivadas", commit: "abcdef1234" };
      if (path === "/admin/rebuild-from-export") {
        const body = JSON.parse(init.body);
        page++;
        return { ok: true, dry_run: body.dry_run, entries_created: 2, entries_updated: 0, entries_unchanged: 0, entries_kept_newer: 0, versions_created: 1, errors: [], skipped_files: [], next_offset: page < 3 ? body.offset + 40 : null, pending_embeddings: 6 };
      }
      return exportReply(path);
    });
    await h.ctx.volExportNow();
    expect(h.panels.get("vol-export-result")!.innerHTML).toContain("export: 1 novas");
    await h.ctx.volRebuild(true);
    const rebuild = h.calls.filter(c => c.path === "/admin/rebuild-from-export").map(c => JSON.parse(c.init.body));
    expect(rebuild.map(b => b.offset)).toEqual([0, 40, 80]);
    expect(rebuild.every(b => b.dry_run === true)).toBe(true);
    expect(h.panels.get("vol-rebuild-result")!.innerHTML).toContain("Simulação");
    expect(h.panels.get("vol-rebuild-result")!.innerHTML).toContain("6 aguardam vetores");
  });
});

describe("tabs", () => {
  it("keeps the access tab as it was and loads the others on demand", async () => {
    const h = setup(answer);
    const tabs = h.ctx.volAdminTabs("access");
    expect(tabs).toContain("Acesso");
    expect(tabs).toContain("Saúde da memória");
    expect(tabs).toContain("Exportação");
    await h.ctx.volAdminTab("health");
    expect(h.calls.some(c => c.path === "/admin/memory-health")).toBe(true);
    expect(h.calls.some(c => c.path === "/admin/export/status")).toBe(false);
  });
});
