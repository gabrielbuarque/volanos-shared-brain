/**
 * Portão de marca (checklist do redesign), na parte que dá para provar por varredura estática:
 * cores só em tokens.css, sombra só em hover e diálogo/toast, fontes locais, ícones sem CDN,
 * sem modo escuro, voz dos catálogos. A parte visual é conferida por scripts/brand-audit.mjs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC = resolve(ROOT, "public");

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(PUBLIC, f).replace(/\\/g, "/");
const sources = walk(PUBLIC, /\.(css|js|html)$/).filter((f) => !/[\\/]fonts[\\/]/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

describe("brand checklist: cores e sombras", () => {
  it("nenhum hex nem rgba fora de css/tokens.css", () => {
    const offenders: string[] = [];
    for (const f of sources) {
      if (rel(f) === "css/tokens.css") continue;
      const text = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      // meta theme-color e manifest precisam de literal; ficam fora da varredura de CSS/JS.
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\(/g)) {
        const before = text.slice(Math.max(0, m.index! - 40), m.index);
        if (/href=|&#|url\(#|id=|"#|'#|\burl\(/.test(before) && m[0].startsWith("#")) continue; // âncoras e ids, não cores
        if (/theme-color/.test(before)) continue;
        offenders.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("box-shadow só aparece em hover, diálogo e toast, ou como none", () => {
    const allowed = /^(var\(--shadow-(raise|float)\)|none)$/;
    const offenders: string[] = [];
    for (const f of walk(resolve(PUBLIC, "css"), /\.css$/)) {
      if (rel(f) === "css/tokens.css") continue;
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const d of m[2].matchAll(/box-shadow\s*:\s*([^;]+)/g)) {
          const value = d[1].trim();
          if (!allowed.test(value)) offenders.push(`${rel(f)}: ${m[1].trim()} -> ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sombra de elevação só em seletores de hover, diálogo ou toast", () => {
    const offenders: string[] = [];
    for (const f of walk(resolve(PUBLIC, "css"), /\.css$/)) {
      if (rel(f) === "css/tokens.css") continue;
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/box-shadow\s*:\s*var\(--shadow-(raise|float)\)/.test(m[2])) continue;
        if (!/hover|is-hover|v-dialog|v-toast|dialog|toast|popover|menu/.test(m[1])) offenders.push(`${rel(f)}: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("brand checklist: fundamentos", () => {
  it("sem modo escuro, sem Tabler, sem CDN de fonte ou ícone", () => {
    for (const f of sources) {
      const text = read(f);
      expect(text, rel(f)).not.toMatch(/data-theme\s*=\s*['"]dark|prefers-color-scheme\s*:\s*dark|tabler|cdn\.jsdelivr|fonts\.googleapis/i);
    }
  });

  it("tipografia: só Montserrat e Merriweather, Merriweather só na virada e em títulos do Canon", () => {
    for (const f of walk(resolve(PUBLIC, "css"), /\.css$/)) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      if (rel(f) !== "css/tokens.css") expect(css, rel(f)).not.toMatch(/font-family\s*:\s*(?!var\(--font-(primary|secondary)\)|inherit)/);
      const uses = [...css.matchAll(/([^{}]+)\{[^{}]*var\(--font-secondary\)[^{}]*\}/g)].map((m) => m[1].trim());
      for (const sel of uses) expect(sel, `${rel(f)}: ${sel}`).toMatch(/em\b|canon|v-title-canon|doc-title/);
    }
  });

  it("transições dentro de 120/200/420ms e easings da marca", () => {
    for (const f of walk(resolve(PUBLIC, "css"), /\.css$/)) {
      if (rel(f) === "css/tokens.css") {
        // Os tokens são o único lugar com a curva e a duração: conferimos que são exatamente os da marca.
        const tokens = read(f);
        expect(tokens).toContain("--ease-standard:cubic-bezier(.4,0,.2,1)");
        expect(tokens).toContain("--ease-out:cubic-bezier(.16,1,.3,1)");
        for (const d of ["120ms", "200ms", "420ms"]) expect(tokens).toContain(d);
        continue;
      }
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, rel(f)).not.toMatch(/cubic-bezier\(|\b\d+m?s\b\s+(ease|linear)/);
      expect(css, rel(f)).not.toMatch(/bounce|spring/);
    }
  });
});

describe("voz dos catálogos", () => {
  function flatten(obj: unknown, out: string[] = []): string[] {
    if (typeof obj === "string") out.push(obj);
    else if (obj && typeof obj === "object") for (const v of Object.values(obj)) flatten(v, out);
    return out;
  }
  const load = (file: string, name: string) => {
    const ctx: any = {};
    vm.createContext(ctx);
    vm.runInContext(`${read(resolve(PUBLIC, "js", file))}\nthis.__c = ${name}`, ctx);
    return ctx.__c;
  };
  for (const [file, name] of [["i18n-pt.js", "I18N_PT"], ["i18n-en.js", "I18N_EN"]] as const) {
    it(`${file}: sem exclamação, emoji nem jargão de campanha`, () => {
      const strings = flatten(load(file, name));
      expect(strings.length).toBeGreaterThan(10);
      for (const s of strings) {
        expect(s, s).not.toMatch(/!/);
        expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(s, s).not.toMatch(/unlock|supercharge|game-changing|best-in-class|revolucion/i);
      }
    });
  }
  it("pt e en têm exatamente as mesmas chaves", () => {
    const keys = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : keys(v, p + k + ".")));
    expect(keys(load("i18n-en.js", "I18N_EN")).sort()).toEqual(keys(load("i18n-pt.js", "I18N_PT")).sort());
  });
});
