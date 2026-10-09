import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CSS_DIR = resolve(ROOT, "public/css");

/**
 * A stylesheet that does not balance is a stylesheet the browser silently
 * truncates.
 *
 * This exists because of a real defect: a merge dropped the closing brace of
 * `.activity-when`, so every rule after it — the whole memories multi-select
 * bar, its count, the per-card tick and the selected-card highlight — was
 * swallowed into that one rule and never applied. The feature shipped visibly
 * unstyled on a phone.
 *
 * Nothing caught it. There is no build step, so no bundler parsed the file;
 * the UI tests run JS in a `vm` with a hand-rolled DOM and never load CSS at
 * all; and `node --check` covers JavaScript only. The suite was green at 2988
 * tests with the stylesheet broken.
 *
 * The parse is deliberately dumb — count braces outside comments and strings —
 * because the property being defended is exactly that dumb: a browser stops
 * applying rules at the point the nesting stops making sense, and everything
 * after it is lost with no error anywhere.
 */
function depthAtEnd(css: string): { depth: number; wentNegative: boolean } {
  let depth = 0;
  let wentNegative = false;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    // comments
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    // strings — a brace inside url("…{…") or content: "}" is not nesting
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) wentNegative = true;
    }
    i++;
  }
  return { depth, wentNegative };
}

const sheets = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));

describe("every stylesheet parses", () => {
  it("finds the stylesheets to check", () => {
    // If this ever reads zero the checks below would pass vacuously.
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets).toContain("tokens.css");
  });

  for (const file of sheets) {
    it(`${file} balances its braces, so nothing after a rule is silently dropped`, () => {
      const css = readFileSync(resolve(CSS_DIR, file), "utf8");
      const { depth, wentNegative } = depthAtEnd(css);
      expect(wentNegative, `${file} closes a block that was never opened`).toBe(false);
      expect(depth, `${file} leaves ${depth} block(s) unclosed — every rule after the unclosed one is swallowed into it and never applies`).toBe(0);
    });
  }
});

