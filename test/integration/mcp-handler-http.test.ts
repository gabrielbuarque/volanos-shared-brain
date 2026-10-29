import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpHandler } from "agents/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiHandler, MAX_MCP_BODY_BYTES } from "../../src/mcp/handler";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function mcpPost(body: unknown) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

describe("MCP HTTP handler (/mcp)", () => {
  let env: Env;
  let handler: ReturnType<typeof createApiHandler>;

  beforeEach(() => {
    env = makeTestEnv();
    handler = createApiHandler();
    vi.mocked(createMcpHandler).mockClear();
    vi.mocked(createMcpHandler).mockReturnValue((() =>
      Promise.resolve(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "remember", description: "Store", inputSchema: {}, execution: { taskSupport: "optional" } },
            { name: "recall", description: "Search", inputSchema: {}, execution: { taskSupport: "optional" } },
          ],
        },
      }), { headers: { "content-type": "application/json" } }))) as never);
  });

  it("tools/list strips execution metadata from the handler response", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    const payload = await res.json() as { result: { tools: { name: string; execution?: unknown }[] } };
    const names = payload.result.tools.map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    for (const tool of payload.result.tools) {
      expect(tool).not.toHaveProperty("execution");
    }
  });

  it("non-tools/list requests pass the downstream response through unchanged", async () => {
    const downstream = new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), {
      headers: { "content-type": "application/json" },
    });
    vi.mocked(createMcpHandler).mockReturnValue((() => Promise.resolve(downstream)) as never);

    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
      env,
      ctx,
    );
    expect(res).toBe(downstream);
  });

  it("rejects a body over the cap with 413 before the SDK sees it", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { pad: "x".repeat(MAX_MCP_BODY_BYTES) } }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    expect(createMcpHandler).not.toHaveBeenCalled();
  });

  it("counts the stream when Content-Length is absent", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_MCP_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await handler.fetch(request, env, ctx);
    expect(res.status).toBe(413);
    expect(createMcpHandler).not.toHaveBeenCalled();
  });
});

describe("MCP tool input element cap", () => {
  it("refuses a call whose arguments exceed maxToolInputElements", async () => {
    const env = makeTestEnv();
    const server = buildMcpServer(env, ctx);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Unknown keys rather than tags: zod would reject 5,000 tags on its own, but it
    // strips unknown keys silently, so only the element cap can fail this call.
    const padding = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, 0]));
    const result = await client.callTool({ name: "remember", arguments: { content: "x", ...padding } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/element|limit/i);
  });
});
