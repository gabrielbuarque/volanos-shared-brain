import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../../src/config";
import { blendScore, buildRerankRequest, parseGrade, rerankCandidates, rerankerMode, RERANK_CRITERIA, RERANK_SNIPPET_CHARS } from "../../src/recall/reranker";
import type { Env } from "../../src/env";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, RERANKER: "jev", ...over }) as Config;
const env = (over: Partial<Env> = {}) => ({ TYPESAFE_API_KEY: "k", ...over }) as unknown as Env;
const items = [
  { id: "a", content: "Alpha title\nalpha body", score: 1 },
  { id: "b", content: "Beta title\nbeta body", score: 0.8 },
  { id: "c", content: "Gamma title\ngamma body", score: 0.6 },
];
const answers = (grades: Record<string, number>[]) => ({
  answers: Object.fromEntries(grades.map((probabilities, i) => [`r${i}`, { probabilities }])),
});
const reply = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as Response;

afterEach(() => vi.restoreAllMocks());

describe("request shape", () => {
  it("sends the question, numbered candidates (title + at most 600 chars) and one 4-criteria choice per candidate", () => {
    const long = { id: "x", content: `Title line\n${"z".repeat(2000)}`, score: 1 };
    const req = buildRerankRequest("what is the plan?", [long, items[1]]);
    expect(req.model).toBe("jev-latest");
    expect(req.state).toContain("Pergunta: what is the plan?");
    expect(req.state).toContain("[1] Title line");
    expect(req.state).toContain("[2] Beta title");
    expect(req.state.match(/z+/)![0].length).toBeLessThanOrEqual(RERANK_SNIPPET_CHARS);
    expect(Object.keys(req.questions)).toEqual(["r0", "r1"]);
    expect((req.questions.r0 as any).type).toBe("choice");
    expect(Object.keys(RERANK_CRITERIA)).toEqual(["1.0", "0.7", "0.3", "0.0"]);
    expect((req.questions.r1 as any).criteria).toBe(RERANK_CRITERIA);
  });
});

describe("grading", () => {
  it("turns probabilities into an expected grade and keeps Jev's confidence", () => {
    const g = parseGrade({ probabilities: { "1.0": 0.5, "0.7": 0.5, "0.3": 0, "0.0": 0 }, confidence: 0.8 })!;
    expect(g.value).toBeCloseTo(0.85);
    expect(g.confidence).toBe(0.8);
    expect(parseGrade({ choice: "0.3", confidence: 0.9 })).toEqual({ value: 0.3, confidence: 0.9 });
    expect(parseGrade({})).toBeNull();
    expect(parseGrade({ probabilities: { nope: 1 } })).toBeNull();
  });

  it("blends 0.7 grader / 0.3 original, and leans on the original when the grader is unsure", () => {
    expect(blendScore(0.5, { value: 1, confidence: 1 }, 0.7)).toBeCloseTo(0.7 * 1 + 0.3 * 0.5);
    expect(blendScore(0.5, { value: 1, confidence: 0 }, 0.7)).toBeCloseTo(0.5);
    expect(blendScore(0.5, null, 0.7)).toBe(0.5);
  });
});

describe("rerankCandidates", () => {
  it("is off unless configured, and never calls out when off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(rerankerMode(cfg({ RERANKER: "whatever" }))).toBe("off");
    const out = await rerankCandidates(env(), cfg({ RERANKER: "off" }), "q", items);
    expect(out.info).toMatchObject({ ran: false, mode: "off" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reorders with ONE call and puts the best answer first", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(answers([
      { "1.0": 0, "0.7": 0, "0.3": 0, "0.0": 1 },
      { "1.0": 0, "0.7": 0, "0.3": 0, "0.0": 1 },
      { "1.0": 1, "0.7": 0, "0.3": 0, "0.0": 0 },
    ])));
    const out = await rerankCandidates(env(), cfg(), "q", items);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.info).toMatchObject({ ran: true, mode: "jev", candidates: 3 });
    const order = [...out.scores!.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order[0]).toBe("c");
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.state).not.toContain("undefined");
  });

  it("keeps the original order and logs reranker_degraded on an HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({}, false, 503));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await rerankCandidates(env(), cfg(), "q", items);
    expect(out.scores).toBeNull();
    expect(out.info).toMatchObject({ ran: false, degraded: "http_503" });
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("reranker_degraded");
    expect(line).not.toContain("alpha body");
  });

  it("gives up after the timeout instead of hanging the search", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await rerankCandidates(env(), cfg({ RERANKER_TIMEOUT_MS: 200 }), "q", items);
    expect(out.info).toMatchObject({ ran: false, degraded: "timeout" });
    expect(out.info.ms).toBeLessThan(2000);
  });

  it("degrades without a key, on an unusable payload, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await rerankCandidates({} as Env, cfg(), "q", items)).info.degraded).toBe("no_api_key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ answers: {} }));
    expect((await rerankCandidates(env(), cfg(), "q", items)).info.degraded).toBe("no_grades");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    expect((await rerankCandidates(env(), cfg(), "q", items)).info.degraded).toBe("boom");
  });

  it("grades at most RERANKER_MAX_CANDIDATES per call", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, content: `t${i}\nbody`, score: 1 - i / 100 }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(answers(many.slice(0, 30).map(() => ({ "1.0": 1 })))));
    await rerankCandidates(env(), cfg({ RERANKER_MAX_CANDIDATES: 30 }), "q", many);
    expect(Object.keys(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).questions)).toHaveLength(30);
  });

  it("bge mode uses Workers AI and no external call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const run = vi.fn().mockResolvedValue({ response: [{ id: 2, score: 0.99 }, { id: 0, score: 0.1 }, { id: 1, score: 0.2 }] });
    const out = await rerankCandidates({ AI: { run } } as unknown as Env, cfg({ RERANKER: "bge" }), "q", items);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toBe("@cf/baai/bge-reranker-base");
    expect(out.info.ran).toBe(true);
    expect([...out.scores!.entries()].sort((a, b) => b[1] - a[1])[0][0]).toBe("c");
  });
});
