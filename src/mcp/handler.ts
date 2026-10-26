import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

// GHSA-46jr-4wx8-v453: agents' WorkerTransport sets no body limit, and
// isMcpToolsListRequest parses the body before the SDK sees it, so the cap lives
// here. 1 MiB is far above any real capture and a quarter of the SDK's default.
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

function bodyTooLarge(): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request body exceeds ${MAX_MCP_BODY_BYTES} bytes` } },
    { status: 413 },
  );
}

// Content-Length can be absent (chunked) or wrong, so the stream is counted too.
async function withBoundedBody(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  if (Number(request.headers.get("content-length")) > MAX_MCP_BODY_BYTES) return bodyTooLarge();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      return bodyTooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      const bounded = await withBoundedBody(request);
      if (bounded instanceof Response) return bounded;
      const server = buildMcpServer(env, ctx, auth);
      const isToolsList = await isMcpToolsListRequest(bounded);
      const response = await createMcpHandler(server)(bounded, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
