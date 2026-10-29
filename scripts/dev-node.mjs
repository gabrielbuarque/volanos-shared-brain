#!/usr/bin/env node
/** Empacota scripts/dev-node/entry.ts com esbuild e sobe o servidor. Veja o cabeçalho de entry.ts. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const stubs = {
  "cloudflare:sockets": "export const connect = () => { throw new Error('cloudflare:sockets indisponível no dev em Node'); };",
  "cloudflare:workers": "export class DurableObject {}; export class WorkerEntrypoint {}; export const env = {};",
  "agents/mcp": "export const createMcpHandler = () => () => new Response('mcp indisponível no dev em Node', { status: 501 });",
  "@cloudflare/workers-oauth-provider": `export class OAuthProvider {
    constructor(o) { this.options = o; }
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === this.options.apiRoute) return new Response('mcp indisponível no dev em Node', { status: 501 });
      return this.options.defaultHandler.fetch(request, env, ctx);
    }
  }`,
};
const stubPlugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:.*|agents\/mcp|@cloudflare\/workers-oauth-provider)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  },
};

mkdirSync(".dev-node", { recursive: true });
const result = await build({
  entryPoints: ["scripts/dev-node/entry.ts"], bundle: true, platform: "node", format: "esm", target: "node22",
  write: false, define: { "import.meta.dirname": JSON.stringify(resolve("test/helpers")) }, plugins: [stubPlugin], external: ["node:*"], logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
writeFileSync(".dev-node/server.mjs", result.outputFiles[0].text);
const child = spawn(process.execPath, [".dev-node/server.mjs"], { stdio: "inherit", env: process.env });
child.on("exit", (c) => process.exit(c ?? 0));
