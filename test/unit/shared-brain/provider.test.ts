import { describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../../../src/config";
import { buildChain, chat, parseOpenRouterModels, providerAllowedFor } from "../../../src/llm/provider";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...over }) as Config;
const envWith = (keys: Record<string, string> = {}, ai: any = { run: vi.fn() }) => ({ AI: ai, OAUTH_KV: { get: async () => null, put: async () => {} }, ...keys }) as any;

describe("provider privacy rule", () => {
  it("never sends P0-P5 context to the free OpenRouter tier", () => {
    for (let level = 0; level <= 5; level++) {
      expect(providerAllowedFor(cfg(), "openrouter", level)).toBe(false);
    }
    expect(providerAllowedFor(cfg(), "openrouter", 6)).toBe(true);
  });
  it("treats an unknown level as restricted", () => {
    expect(providerAllowedFor(cfg(), "openrouter", undefined)).toBe(false);
    expect(providerAllowedFor(cfg(), "nim", undefined)).toBe(true);
    expect(providerAllowedFor(cfg(), "workers-ai", undefined)).toBe(true);
  });
  it("drops OpenRouter from the chain for restricted context even when preferred", () => {
    const env = envWith({ OPENROUTER_API_KEY: "k", NVIDIA_API_KEY: "n" });
    const chain = buildChain(env, cfg(), { provider: "openrouter", minClearance: 3 });
    expect(chain.map(c => c.provider)).toEqual(["nim", "workers-ai"]);
  });
  it("uses the preferred provider first for open context, then the order", () => {
    const env = envWith({ OPENROUTER_API_KEY: "k", NVIDIA_API_KEY: "n" });
    const chain = buildChain(env, cfg(), { provider: "nim", model: "meta/x", minClearance: 9 });
    expect(chain.map(c => `${c.provider}:${c.model}`)).toEqual(["nim:meta/x", "openrouter:openrouter/free", "workers-ai:" + DEFAULTS.LLM_MODEL]);
  });
  it("skips providers with no secret and always ends on Workers AI", () => {
    expect(buildChain(envWith(), cfg(), { minClearance: 12 }).map(c => c.provider)).toEqual(["workers-ai"]);
  });
  it("ignores a model the admin allowlist hides", () => {
    const env = envWith({ NVIDIA_API_KEY: "n" });
    const chain = buildChain(env, cfg({ LLM_MODEL_ALLOWLIST: "meta/ok" }), { provider: "nim", model: "meta/hidden", minClearance: 9 });
    expect(chain[0]).toEqual({ provider: "nim", model: "meta/llama-3.3-70b-instruct" });
  });
});

describe("chat fallback", () => {
  it("falls back on 429 and reports who answered", async () => {
    const run = vi.fn().mockResolvedValue(new ReadableStream());
    const env = envWith({ OPENROUTER_API_KEY: "k" }, { run });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    const res = await chat(env, cfg(), [{ role: "user", content: "hi" }], { minClearance: 9 });
    vi.unstubAllGlobals();
    expect(res.provider).toBe("workers-ai");
    expect(res.skipped).toEqual([{ provider: "openrouter", status: 429 }]);
  });
  it("sends the key only as a bearer header and asks for streaming", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("data: x\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await chat(envWith({ NVIDIA_API_KEY: "secret" }), cfg(), [{ role: "user", content: "hi" }], { provider: "nim", minClearance: 2 });
    vi.unstubAllGlobals();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body).stream).toBe(true);
    expect(init.body).not.toContain("secret");
  });
  it("moves on to the next provider after an auth error", async () => {
    const run = vi.fn().mockResolvedValue(new ReadableStream());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    const res = await chat(envWith({ NVIDIA_API_KEY: "bad" }, { run }), cfg(), [{ role: "user", content: "x" }], { provider: "nim" });
    vi.unstubAllGlobals();
    expect(res.provider).toBe("workers-ai");
  });
});

describe("OpenRouter catalogue", () => {
  it("keeps only zero-price models plus the free router", () => {
    const out = parseOpenRouterModels({ data: [
      { id: "a/free:free", name: "A", pricing: { prompt: "0", completion: "0" } },
      { id: "b/paid", name: "B", pricing: { prompt: "0.001", completion: "0.002" } },
    ] });
    expect(out.map(m => m.id)).toEqual(["openrouter/free", "a/free:free"]);
  });
});
