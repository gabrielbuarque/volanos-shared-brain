import type { Env } from "../env";
import type { Config } from "../config";
import { readStreamText } from "../lib/ai";

/**
 * Provider layer for every text-generation call. Two OpenAI-compatible hosts
 * (OpenRouter, NVIDIA NIM) plus Workers AI as the always-available reserve.
 *
 * Privacy rule: a provider listed in config.LLM_RESTRICTED_PROVIDERS may see
 * memories of any clearance. Every other provider (the free OpenRouter tier)
 * is only used when the caller can prove the context is open enough, i.e.
 * `minClearance >= FREE_MODEL_MIN_CLEARANCE`. A caller that does not know the
 * clearance of what it sends passes nothing, which counts as restricted.
 */

export type ProviderId = "openrouter" | "nim" | "workers-ai";
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export const PROVIDER_IDS: readonly ProviderId[] = ["openrouter", "nim", "workers-ai"];
/** P6 and above may go to a free model; P0-P5 may not. */
export const FREE_MODEL_MIN_CLEARANCE = 6;

export const OPENAI_COMPATIBLE: Record<"openrouter" | "nim", { baseUrl: string; defaultModel: string; keyName: "OPENROUTER_API_KEY" | "NVIDIA_API_KEY" }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/free", keyName: "OPENROUTER_API_KEY" },
  nim: { baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "meta/llama-3.3-70b-instruct", keyName: "NVIDIA_API_KEY" },
};

export interface ChatOptions {
  /** Preferred provider/model (from the user's picker). Falls back down the chain. */
  provider?: string;
  model?: string;
  /** Lowest clearance level (most restricted) present in the context. Undefined = unknown. */
  minClearance?: number;
  maxTokens?: number;
  /** Override the Workers AI model (e.g. INSIGHT_LLM_MODEL). */
  workersModel?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  stream: ReadableStream;
  provider: ProviderId;
  model: string;
  /** Providers that failed before this one answered, with the reason. */
  skipped: { provider: ProviderId; status: number | string }[];
}

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

function csv(value: string): string[] {
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

export function providerConfigured(env: Env, id: ProviderId): boolean {
  if (id === "workers-ai") return !!env.AI;
  return !!env[OPENAI_COMPATIBLE[id].keyName];
}

/** May this provider receive a context whose most restricted trecho is `minClearance`? */
export function providerAllowedFor(config: Readonly<Config>, id: ProviderId, minClearance: number | undefined): boolean {
  if (typeof minClearance === "number" && minClearance >= FREE_MODEL_MIN_CLEARANCE) return true;
  return csv(config.LLM_RESTRICTED_PROVIDERS).includes(id);
}

export function modelAllowed(config: Readonly<Config>, model: string): boolean {
  const list = csv(config.LLM_MODEL_ALLOWLIST);
  return list.includes("*") || list.includes(model);
}

/** Ordered candidates for one call. Pure, so the privacy rule is unit-testable. */
export function buildChain(
  env: Env,
  config: Readonly<Config>,
  opts: Pick<ChatOptions, "provider" | "model" | "minClearance">,
): { provider: ProviderId; model: string }[] {
  const order = csv(config.LLM_PROVIDER_ORDER).filter(isProviderId);
  if (!order.includes("workers-ai")) order.push("workers-ai");
  const preferred = isProviderId(opts.provider) ? opts.provider : isProviderId(config.LLM_DEFAULT_PROVIDER) ? config.LLM_DEFAULT_PROVIDER : undefined;
  const sorted = preferred ? [preferred, ...order.filter(p => p !== preferred)] : order;
  const chain: { provider: ProviderId; model: string }[] = [];
  for (const provider of sorted) {
    if (!providerConfigured(env, provider)) continue;
    if (!providerAllowedFor(config, provider, opts.minClearance)) continue;
    let model: string;
    if (provider === "workers-ai") model = config.LLM_MODEL;
    else {
      const fromAdmin = provider === config.LLM_DEFAULT_PROVIDER && config.LLM_DEFAULT_MODEL !== "auto" ? config.LLM_DEFAULT_MODEL : "";
      const wanted = provider === preferred ? (opts.model || fromAdmin) : "";
      model = wanted && modelAllowed(config, wanted) ? wanted : OPENAI_COMPATIBLE[provider].defaultModel;
    }
    chain.push({ provider, model });
  }
  // Workers AI is the reserve and is in every restricted list by default; if an
  // admin removed it, an empty chain surfaces as an error rather than a leak.
  return chain;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function callOpenAiCompatible(
  env: Env,
  provider: "openrouter" | "nim",
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<{ stream?: ReadableStream; status: number }> {
  const spec = OPENAI_COMPATIBLE[provider];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env[spec.keyName]}`,
  };
  if (provider === "openrouter") headers["X-Title"] = "Volanos Shared Brain";
  const res = await fetch(`${spec.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, stream: true, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    try { await res.body?.cancel(); } catch { /* body already consumed */ }
    return { status: res.status };
  }
  return { stream: res.body, status: res.status };
}

/** Streams a chat completion, walking the chain on 429/5xx/network errors. */
export async function chat(
  env: Env,
  config: Readonly<Config>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const chain = buildChain(env, config, opts);
  if (!chain.length) throw new Error("No LLM provider is allowed for this context");
  const skipped: ChatResult["skipped"] = [];
  let lastError: unknown;
  for (const { provider, model } of chain) {
    try {
      if (provider === "workers-ai") {
        const useModel = opts.workersModel ?? model;
        const stream = await (env.AI as any).run(useModel as any, {
          messages,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          stream: true,
        });
        return { stream: stream as ReadableStream, provider, model: useModel, skipped };
      }
      const out = await callOpenAiCompatible(env, provider, model, messages, opts);
      if (out.stream) return { stream: out.stream, provider, model, skipped };
      skipped.push({ provider, status: out.status });
      if (!retryable(out.status)) lastError = new Error(`${provider} returned ${out.status}`);
    } catch (e) {
      lastError = e;
      skipped.push({ provider, status: "network" });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
}

/** Non-streaming convenience for the background callers (digest, insight, classify…). */
export async function chatText(
  env: Env,
  config: Readonly<Config>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const result = await chat(env, config, messages, opts);
  return readStreamText(result.stream);
}

// ── Model catalogue (GET /llm/models) ───────────────────────────────────────

export interface ModelOption { provider: ProviderId; id: string; label: string }

export function parseOpenRouterModels(payload: any): ModelOption[] {
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : [];
  const free = rows.filter(m => {
    const p = m?.pricing;
    return p && Number(p.prompt) === 0 && Number(p.completion) === 0 && typeof m.id === "string";
  });
  const out: ModelOption[] = [{ provider: "openrouter", id: "openrouter/free", label: "OpenRouter · Free (automático)" }];
  for (const m of free) out.push({ provider: "openrouter", id: m.id, label: `OpenRouter · ${m.name ?? m.id}` });
  return out;
}

export function parseNimModels(payload: any): ModelOption[] {
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter(m => typeof m?.id === "string").map(m => ({ provider: "nim" as const, id: m.id, label: `NVIDIA NIM · ${m.id}` }));
}

const MODELS_CACHE_KEY = "llm:models:v1";
const MODELS_TTL_SECONDS = 3600;

export async function listModels(env: Env, config: Readonly<Config>): Promise<ModelOption[]> {
  let all: ModelOption[] | null = null;
  try {
    const cached = await env.OAUTH_KV.get(MODELS_CACHE_KEY);
    if (cached) all = JSON.parse(cached) as ModelOption[];
  } catch { /* cache miss */ }
  if (!all) {
    all = [{ provider: "workers-ai", id: config.LLM_MODEL, label: `Workers AI · ${config.LLM_MODEL.split("/").pop()}` }];
    for (const provider of ["openrouter", "nim"] as const) {
      if (!providerConfigured(env, provider)) continue;
      const spec = OPENAI_COMPATIBLE[provider];
      try {
        const res = await fetch(`${spec.baseUrl}/models`, { headers: { Authorization: `Bearer ${env[spec.keyName]}` } });
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        all.push(...(provider === "openrouter" ? parseOpenRouterModels(payload) : parseNimModels(payload)));
      } catch {
        // A provider whose catalogue is unreachable still offers its default.
        all.push({ provider, id: spec.defaultModel, label: `${provider === "nim" ? "NVIDIA NIM" : "OpenRouter"} · ${spec.defaultModel}` });
      }
    }
    try { await env.OAUTH_KV.put(MODELS_CACHE_KEY, JSON.stringify(all), { expirationTtl: MODELS_TTL_SECONDS }); } catch { /* best effort */ }
  }
  return all.filter(m => providerConfigured(env, m.provider) && (m.provider === "workers-ai" || modelAllowed(config, m.id)));
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Wrap a provider stream as an SSE body whose first event names the model that
 * answered (`sb_meta`), so a fallback is visible. Clients that only read
 * `response`/`choices` ignore the extra event.
 */
export function streamWithMeta(result: ChatResult, extra: Record<string, unknown> = {}): ReadableStream {
  const meta = `data: ${JSON.stringify({ sb_meta: { provider: result.provider, model: result.model, fallback: result.skipped.length > 0, ...extra } })}\n\n`;
  const upstream = result.stream;
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(meta));
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (e) { controller.error(e); }
    },
    cancel() { return upstream.cancel(); },
  });
}
