#!/usr/bin/env node
/**
 * Creates the Vectorize metadata indexes the permission filter depends on.
 *
 * Run once, BEFORE the first ingest: Vectorize only filters on metadata
 * properties that were indexed when the vectors were written. Without these two
 * the query falls back to unfiltered top-K (see src/vectorize/scope.ts) and the
 * D1 hydration step drops what the caller may not read. That is safe, but
 * forbidden chunks can crowd the top-K and the answer gets worse.
 *
 *   workspace_id     string   $in filter on the caller's workspaces
 *   clearance_level  number   $gte filter on the caller's clearance floor
 *
 * Usage: node scripts/vectorize-indexes.mjs [index-name]
 */
import { spawnSync } from "node:child_process";

const index = process.argv[2] ?? "second-brain-vectors";
const wanted = [["workspace_id", "string"], ["clearance_level", "number"]];

for (const [property, type] of wanted) {
  const run = spawnSync("npx", ["wrangler", "vectorize", "create-metadata-index", index, `--propertyName=${property}`, `--type=${type}`], { stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });
  const out = `${run.stdout}${run.stderr}`;
  if (run.status === 0) console.log(`created   ${property} (${type})`);
  else if (/already exists|duplicate/i.test(out)) console.log(`exists    ${property} (${type})`);
  else { console.error(`failed    ${property}\n${out}`); process.exit(1); }
}
const list = spawnSync("npx", ["wrangler", "vectorize", "list-metadata-index", index], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(list.status ?? 0);
