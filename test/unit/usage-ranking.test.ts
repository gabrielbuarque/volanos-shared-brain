import { describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../../src/config";
import { halfLifeDays, memoryTypeOf, usageBonus } from "../../src/memory/usage";
import { rerankWithTimeDecay, type VectorizeMatch } from "../../src/recall/math";

const cfg = DEFAULTS as unknown as Config;
const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);

describe("memory type and half-life", () => {
  it("classifies decisions and meeting notes (accents and case folded), everything else is default", () => {
    expect(memoryTypeOf(["Decisão"])).toBe("decision");
    expect(memoryTypeOf(["adr"])).toBe("decision");
    expect(memoryTypeOf(["reunião"])).toBe("meeting");
    expect(memoryTypeOf(["x"], "meeting-notes")).toBe("meeting");
    expect(memoryTypeOf(["x"], "api")).toBe("other");
    expect(halfLifeDays("decision", cfg)).toBe(180);
    expect(halfLifeDays("meeting", cfg)).toBe(45);
    expect(halfLifeDays("other", cfg)).toBe(90);
  });
});

describe("usageBonus", () => {
  const used = (days: number, tags: string[] = [], count = 20) => usageBonus({ accessCount: count, lastAccessedAt: now - days * DAY, tags }, cfg, now);

  it("is zero for a memory nobody touched, and never negative", () => {
    expect(usageBonus({ accessCount: 0, lastAccessedAt: null, tags: [] }, cfg, now)).toBe(0);
    expect(usageBonus({ accessCount: 5, lastAccessedAt: null, tags: [] }, cfg, now)).toBe(0);
    for (const days of [0, 1, 45, 400, 5000]) expect(used(days)).toBeGreaterThanOrEqual(0);
  });

  it("grows with use but is capped at USAGE_BONUS_MAX", () => {
    expect(used(0, [], 2)).toBeLessThan(used(0, [], 20));
    expect(used(0, [], 1_000_000)).toBeLessThanOrEqual(cfg.USAGE_BONUS_MAX);
  });

  it("halves after one half-life, and meeting notes fade faster than decisions", () => {
    expect(used(90) / used(0)).toBeCloseTo(0.5, 5);
    expect(used(45, ["reuniao"]) / used(0, ["reuniao"])).toBeCloseTo(0.5, 5);
    expect(used(180, ["decision"]) / used(0, ["decision"])).toBeCloseTo(0.5, 5);
    expect(used(90, ["decision"])).toBeGreaterThan(used(90, ["reuniao"]));
  });
});

describe("the bonus only ever adds to a score", () => {
  const match = (id: string, score: number): VectorizeMatch => ({ id, score, metadata: { parentId: id, created_at: now } });
  const matches = [match("a", 0.5), match("b", 0.4), match("c", 0.3)];

  it("never lowers or hides a candidate, whatever the usage", () => {
    const without = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg);
    const usage = new Map([
      ["a", { accessCount: 0, lastAccessedAt: null, tags: [] as string[] }],
      ["b", { accessCount: 50, lastAccessedAt: now - 1 * DAY, tags: [] as string[] }],
      ["c", { accessCount: 3, lastAccessedAt: now - 3000 * DAY, tags: [] as string[] }],
    ]);
    const withUsage = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, { usage });
    expect(withUsage).toHaveLength(without.length);
    // A hair of tolerance: the two calls read the clock separately for recency decay.
    for (const m of withUsage) expect(m.score).toBeGreaterThanOrEqual(without.find(w => w.id === m.id)!.score * (1 - 1e-6));
  });

  it("lets a well-used memory edge out an equally relevant unused one", () => {
    const tie = [match("unused", 0.5), match("used", 0.5)];
    const usage = new Map([["used", { accessCount: 30, lastAccessedAt: Date.now() - DAY, tags: [] as string[] }]]);
    const ranked = rerankWithTimeDecay(tie, new Map(), new Map(), [], new Map(), new Map(), new Map(), cfg, { usage });
    expect(ranked[0].id).toBe("used");
  });
});
