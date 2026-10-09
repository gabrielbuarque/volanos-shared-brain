/**
 * Componentes do Volanos UI e utilitários do front, rodando os scripts reais num vm com um DOM mínimo.
 * Foco: contrato dos componentes (classes, aria, teclado), leitura segura da resposta e do stream.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, "public", rel), "utf8");

class FakeNode {
  nodeType = 1;
  tag: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parent: FakeNode | null = null;
  _text = "";
  innerHTML = "";
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k.startsWith("data-")) this.dataset[k.slice(5)] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: any) { c.parent = this; this.children.push(c); return c; }
  addEventListener(ev: string, fn: (e: any) => void) { (this.listeners[ev] ||= []).push(fn); }
  focus() { (globalThis as any).__focused = this; }
  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) ?? null; }
  get classList() { const self = this; return { add: (c: string) => self.attrs.class = `${self.attrs.class ?? ""} ${c}`.trim(), remove: (c: string) => self.attrs.class = (self.attrs.class ?? "").split(" ").filter((x) => x !== c).join(" ") }; }
  get textContent(): string { return this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(""); }
  fire(ev: string, e: any = {}) { for (const fn of this.listeners[ev] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...e }); }
  find(pred: (n: FakeNode) => boolean): FakeNode[] { const out: FakeNode[] = []; const walk = (n: any) => { if (n.nodeType === 1) { if (pred(n)) out.push(n); n.children.forEach(walk); } }; walk(this); return out; }
  cls() { return (this.attrs.class ?? "").split(" "); }
}

function makeCtx() {
  const store = new Map<string, string>();
  const ctx: any = {
    console,
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    navigator: { language: "pt-BR" },
    document: {
      documentElement: { lang: "pt-BR" },
      createElement: (t: string) => new FakeNode(t),
      createElementNS: (_: string, t: string) => new FakeNode(t),
      createTextNode: (d: string) => ({ nodeType: 3, data: d }),
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["js/i18n-pt.js", "js/i18n-en.js", "js/i18n.js", "js/ui/dom.js", "js/ui/icons.js", "js/ui/brand.js", "js/ui/core.js", "js/ui/forms.js", "js/ui/feedback.js", "js/core/format.js", "js/core/stream.js"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  vm.runInContext("initI18n('pt')", ctx);
  return ctx;
}
const ctx = makeCtx();
const V = ctx.VUI;

describe("Button, IconButton, Tag, LevelPill", () => {
  it("Button: variante e tamanho viram classes; href vira <a>; desabilitado não dispara", () => {
    let clicks = 0;
    const b = V.Button({ variant: "secondary", size: "sm", onClick: () => clicks++ }, "Ok");
    expect(b.tag).toBe("button");
    expect(b.cls()).toEqual(expect.arrayContaining(["v-btn", "v-btn--secondary", "v-btn--sm"]));
    b.fire("click");
    expect(clicks).toBe(1);
    const d = V.Button({ disabled: true, onClick: () => clicks++ }, "Ok");
    d.fire("click");
    expect(clicks).toBe(1);
    expect(V.Button({ href: "#/x" }, "Ir").tag).toBe("a");
  });

  it("IconButton exige rótulo acessível", () => {
    const b = V.IconButton({ icon: "x", label: "Fechar" });
    expect(b.attrs["aria-label"]).toBe("Fechar");
    expect(b.attrs.title).toBe("Fechar");
  });

  it("LevelPill agrupa por forma e sempre escreve o nível", () => {
    const shape = (n: number) => V.LevelPill({ level: n }).cls().find((c: string) => c.startsWith("v-level--") && c !== "v-level--sm");
    expect([0, 3].map(shape)).toEqual(["v-level--high", "v-level--high"]);
    expect([4, 8].map(shape)).toEqual(["v-level--mid", "v-level--mid"]);
    expect([9, 12].map(shape)).toEqual(["v-level--low", "v-level--low"]);
    expect(V.LevelPill({ level: 7 }).textContent).toBe("P7");
    expect(V.LevelPill({ level: 99 }).textContent).toBe("P?");
  });

  it("Tag removível devolve um botão com rótulo", () => {
    const tag = V.Tag({ onRemove: () => {}, removeLabel: "Remover Dique" }, "Dique");
    const rm = tag.find((n: FakeNode) => n.cls().includes("v-tag__remove"))[0];
    expect(rm.attrs["aria-label"]).toBe("Remover Dique");
  });
});

describe("Tabs", () => {
  it("setas, Home e End trocam a aba e o tabindex acompanha", () => {
    const seen: string[] = [];
    const tabs = V.Tabs({ items: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], onChange: (id: string) => seen.push(id) });
    const buttons = tabs.find((n: FakeNode) => n.attrs.role === "tab");
    expect(buttons.map((b: FakeNode) => b.attrs["aria-selected"])).toEqual(["true", "false", "false"]);
    tabs.fire("keydown", { key: "ArrowRight" });
    tabs.fire("keydown", { key: "End" });
    tabs.fire("keydown", { key: "ArrowRight" });
    expect(seen).toEqual(["b", "c", "a"]);
    expect(buttons.map((b: FakeNode) => b.attrs.tabindex)).toEqual(["0", "-1", "-1"]);
  });
});

describe("Input e Select", () => {
  it("erro engrossa a borda via aria-invalid e liga a mensagem ao campo", () => {
    const f = V.Input({ label: "E-mail", error: "Use o e-mail da Volanos." });
    expect(f.control.attrs["aria-invalid"]).toBe("true");
    const msg = f.find((n: FakeNode) => n.cls().includes("v-field__hint--error"))[0];
    expect(f.control.attrs["aria-describedby"]).toBe(msg.attrs.id);
  });
});

describe("resposta e documento em DOM seguro", () => {
  it("frase direta primeiro, chips só no intervalo, texto nunca vira marcação", () => {
    const cites: number[] = [];
    const el = ctx.Fmt.renderAnswer("A meta é 900 [1].\n\n- Ata diz 1.200 [2] e <b>x</b> [9]", { max: 2, onCite: (n: number) => cites.push(n) });
    const lead = el.find((n: FakeNode) => n.cls().includes("answer__lead"))[0];
    expect(lead.textContent).toBe("A meta é 900 [1].");
    const chips = el.find((n: FakeNode) => n.cls().includes("cite"));
    expect(chips.map((c: FakeNode) => c.textContent)).toEqual(["[1]", "[2]"]);
    chips[1].fire("click");
    expect(cites).toEqual([2]);
    expect(el.textContent).toContain("<b>x</b> [9]");
    expect(el.find((n: FakeNode) => n.tag === "b")).toHaveLength(0);
  });

  it("o primeiro ponto que repete a frase direta não aparece duas vezes", () => {
    const el = ctx.Fmt.renderAnswer("A meta é 900 leads [1].\n- A meta é 900 leads [1].\n- A ata diz 1.200 [2]", { max: 2 });
    expect(el.find((n: FakeNode) => n.tag === "li").map((n: FakeNode) => n.textContent)).toEqual(["A ata diz 1.200 [2]"]);
  });

  it("diferença de versões: só linhas que mudaram, com marca de adicionado e removido", () => {
    const ops = ctx.Fmt.lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(ops.map((o: { t: string; text: string }) => o.t + ":" + o.text)).toEqual(["same:a", "del:b", "add:B", "same:c", "add:d"]);
  });

  it("documento: o primeiro # é o título e cada ## abre uma seção com regra", () => {
    const el = ctx.Fmt.renderDocument("# Título\n\nIntro.\n\n## Escopo\n- um\n- dois");
    expect(el.textContent).not.toContain("Título");
    expect(el.find((n: FakeNode) => n.tag === "h2")).toHaveLength(1);
    expect(el.find((n: FakeNode) => n.tag === "hr")).toHaveLength(1);
    expect(el.find((n: FakeNode) => n.tag === "li")).toHaveLength(2);
  });
});

describe("formatação", () => {
  it("titleOf e bodyOf separam o cabeçalho", () => {
    expect(ctx.Fmt.titleOf("# Resumo da Dique\nTexto.")).toBe("Resumo da Dique");
    expect(ctx.Fmt.bodyOf("# Resumo da Dique\nTexto.")).toBe("Texto.");
  });
  it("relativeTime fala em dias, meses e anos", () => {
    const now = Date.now();
    expect(ctx.Fmt.relativeTime(now - 5 * 86400000, now)).toBe("há 5 dias");
    expect(ctx.Fmt.relativeTime(now - 400 * 86400000, now)).toBe("há 1 ano");
    expect(ctx.Fmt.relativeTime(now, now)).toBe("hoje");
  });
  it("estado de revisão sem estado diz 'Não revisado'", () => {
    expect(ctx.Fmt.reviewLabel(null)).toBe("Não revisado");
    expect(ctx.Fmt.reviewLabel("verified")).toBe("Verificado");
  });
});

describe("stream do /chat", () => {
  it("reconstrói uma linha partida entre pedaços e ignora o raciocínio", () => {
    const out: string[] = [];
    let buf = "";
    const onText = (t: string) => out.push(t);
    buf = ctx.ChatStream.feed(buf, 'data: {"response":"Ol', onText);
    buf = ctx.ChatStream.feed(buf, 'á"}\n\ndata: {"choices":[{"delta":{"reasoning":"x","content":" mundo"}}]}\n', onText);
    expect(out.join("")).toBe("Olá mundo");
  });
  it("entrega o sb_meta separado do texto", () => {
    let meta: any = null;
    const out: string[] = [];
    ctx.ChatStream.feed("", 'data: {"sb_meta":{"provider":"workers-ai","model":"m"}}\n', (t: string) => out.push(t), (m: any) => (meta = m));
    expect(meta.model).toBe("m");
    expect(out).toEqual([]);
  });
});

describe("i18n: toda chave usada existe em pt e en", () => {
  it("t('x.y') e tPlural('x.y') literais em public/js resolvem nos dois catálogos", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const f = resolve(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".js") && !/i18n/.test(n)) files.push(f); } };
    walk(resolve(ROOT, "public/js"));
    const missing: string[] = [];
    const has = (cat: any, key: string) => key.split(".").reduce((o: any, k) => (o == null ? o : o[k]), cat) !== undefined;
    const pt = vm.runInContext("I18N_PT", ctx);
    const en = vm.runInContext("I18N_EN", ctx);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Chaves que terminam em "." são prefixos de chave dinâmica (t('source.' + kind)): não dá para resolver aqui.
      for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]*[a-zA-Z0-9_])'/g)) for (const [n, cat] of [["pt", pt], ["en", en]] as const) if (!has(cat, m[1])) missing.push(`${n}:${m[1]} (${f.split("public")[1]})`);
      for (const m of src.matchAll(/\btPlural\('([a-zA-Z0-9_.]+)'/g)) for (const [n, cat] of [["pt", pt], ["en", en]] as const) if (!has(cat, m[1] + ".one") || !has(cat, m[1] + ".other")) missing.push(`${n}:${m[1]}[plural]`);
    }
    expect(missing).toEqual([]);
  });
});
