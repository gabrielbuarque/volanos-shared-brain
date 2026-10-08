import { describe, expect, it } from "vitest";
import { decide, conservativeLevel } from "../../../src/ingest/decide";
import { batches, buildRequest, parseAnswer } from "../../../src/ingest/jev";
import { DEFAULT_LEVELS, levelCriteria, mergeLevels } from "../../../src/ingest/levels";
import { nodesWithContent, parseMarkdown, worthTree, CHUNK_MAX_CHARS } from "../../../src/ingest/tree";
import { parseNodeChoice, pruneTree, treePrompt, type ReadableChunk } from "../../../src/pageindex";

const cls = (level: number, confidence: number, top3 = [{ level, p: confidence }]) => ({ level, confidence, top3, model: "jev" });

describe("decide", () => {
  it("publishes at or above the sender's level", () => {
    expect(decide(cls(9, 0.95), { floor: 7 })).toMatchObject({ outcome: "publish", level: 9, review: false });
    expect(decide(cls(7, 0.9), { floor: 7 }).outcome).toBe("publish");
  });
  it("quarantines a chunk more restricted than the sender (P7 sends P3)", () => {
    expect(decide(cls(3, 0.9), { floor: 7 })).toMatchObject({ outcome: "quarantine", level: 3, reason: "above-submitter" });
  });
  it("takes the more restrictive of the top two when confidence is low", () => {
    const d = decide(cls(8, 0.4, [{ level: 8, p: 0.4 }, { level: 5, p: 0.35 }]), { floor: 0 });
    expect(d.level).toBe(5);
    expect(d.review).toBe(true);
  });
  it("takes the more restrictive when the top two levels are more than 3 apart", () => {
    expect(conservativeLevel(cls(10, 0.8, [{ level: 10, p: 0.5 }, { level: 2, p: 0.3 }]))).toMatchObject({ level: 2, review: true, reason: "ambiguous-levels" });
  });
  it("ignores a runner-up under 15% when judging ambiguity", () => {
    expect(conservativeLevel(cls(10, 0.9, [{ level: 10, p: 0.9 }, { level: 2, p: 0.05 }]))).toMatchObject({ level: 10, review: false });
  });
  it("fails closed when the classifier gave nothing", () => {
    expect(decide(null, { floor: 7 })).toMatchObject({ outcome: "quarantine", level: 0, reason: "classifier-unavailable" });
  });
  it("direct publish skips the queue for review-only chunks, never for chunks above the sender", () => {
    const unsure = cls(8, 0.4, [{ level: 8, p: 0.4 }, { level: 7, p: 0.3 }]);
    expect(decide(unsure, { floor: 7 }).outcome).toBe("quarantine");
    expect(decide(unsure, { floor: 7, directPublish: true })).toMatchObject({ outcome: "publish", review: true });
    expect(decide(cls(3, 0.95), { floor: 7, directPublish: true }).outcome).toBe("quarantine");
  });
});

describe("tree", () => {
  const md = "# Finanças\n\nReceita do Q3 foi alta.\n\n## Salários\n\nReajuste da designer.\n\nOutro parágrafo.\n\n# Processos\n\nComo pedir ferramenta.";
  it("builds one node per heading with paths and one chunk per paragraph", () => {
    const doc = parseMarkdown(md);
    expect(doc.nodes.map(n => n.path)).toEqual(["Finanças", "Finanças > Salários", "Processos"]);
    expect(doc.chunks.map(c => [c.nodeId, c.text])).toEqual([
      ["0001", "Receita do Q3 foi alta."], ["0002", "Reajuste da designer."], ["0002", "Outro parágrafo."], ["0003", "Como pedir ferramenta."],
    ]);
    expect(doc.chunks[1].path).toBe("Finanças > Salários");
  });
  it("splits paragraphs over the cap and keeps headings inside code fences as text", () => {
    const long = "Frase um. ".repeat(400);
    const fence = "```";
    const doc = parseMarkdown(`# T\n\n${long}\n\n${fence}\n# not a heading\n${fence}`);
    expect(doc.chunks.every(c => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
    expect(doc.nodes).toHaveLength(1);
    expect(doc.chunks.at(-1)!.text).toContain("# not a heading");
  });
  it("puts headingless text under a fallback node", () => {
    expect(parseMarkdown("só texto", "nota.md").nodes[0].title).toBe("nota.md");
  });
  it("uses the tree only for 3+ sections or long documents", () => {
    expect(worthTree(parseMarkdown("# A\n\nx"))).toBe(false);
    expect(worthTree(parseMarkdown(md))).toBe(true);
    expect(nodesWithContent(parseMarkdown("# A\n\n## B\n\nx")).map(n => n.title)).toEqual(["A", "B"]);
  });
});

describe("jev client", () => {
  it("batches 13 at a time", () => {
    expect(batches(Array.from({ length: 52 }, (_, i) => i)).map(b => b.length)).toEqual([13, 13, 13, 13]);
  });
  it("builds one choice question per chunk with all 13 levels as options", () => {
    const doc = parseMarkdown("# A\n\none\n\ntwo");
    const req = buildRequest(doc.chunks, DEFAULT_LEVELS);
    expect(Object.keys(req.questions)).toEqual(["c0", "c1"]);
    expect(Object.keys((req.questions.c0 as any).criteria)).toHaveLength(13);
    expect((req.questions.c0 as any).instructions).toContain("nível mais restrito");
  });
  it("parses probabilities into a ranked top 3", () => {
    const out = parseAnswer({ choice: "P3", confidence: 0.7, probabilities: { P3: 0.7, P2: 0.2, P7: 0.05, P12: 0.05 } }, "jev-x");
    expect(out).toMatchObject({ level: 3, confidence: 0.7 });
    expect(out!.top3.map(t => t.level)).toEqual([3, 2, 7]);
    expect(parseAnswer({ choice: "P3" }, "m")).toBeNull();
  });
});

describe("levels", () => {
  it("merges edits over the 13 defaults and ignores junk", () => {
    const merged = mergeLevels([{ level: 3, reads: "Receita e caixa" }, { level: 99, reads: "x" }, "oops"]);
    expect(merged).toHaveLength(13);
    expect(merged[3].reads).toBe("Receita e caixa");
    expect(merged[3].holders).toBe(DEFAULT_LEVELS[3].holders);
  });
  it("hands the rubric the same texts the UI shows", () => {
    expect(levelCriteria(DEFAULT_LEVELS).P0).toContain(DEFAULT_LEVELS[0].reads);
  });
});

describe("pageindex prune", () => {
  const chunk = (nodeId: string, ord: number, content: string, clearance: number): ReadableChunk => ({ nodeId, nodeTitle: `T${nodeId}`, nodePath: `T${nodeId}`, parentId: null, ord, entryId: `e${ord}`, content, clearance });
  it("never mentions a node whose chunks the caller could not read", () => {
    // The SQL filter already dropped the P3 chunk; the P8 one is all that arrives.
    const nodes = pruneTree([chunk("0002", 1, "Processo aberto", 8)]);
    expect(nodes.map(n => n.id)).toEqual(["0002"]);
    expect(treePrompt("pergunta", nodes)).not.toContain("0001");
  });
  it("only accepts node ids that exist in the pruned tree", () => {
    const valid = new Set(["0002", "0003"]);
    expect(parseNodeChoice('{"node_ids":["0001","0002","0003"]}', valid)).toEqual(["0002", "0003"]);
    expect(parseNodeChoice("0003 e 0001", valid)).toEqual(["0003"]);
  });
});
