import type { IntegrationEnv, IntegrationProvider, ItemMapEntry, MirrorEntryOptions, MirrorStore, SyncOutcome } from "./framework";
import { loadIntegration, saveIntegration } from "./framework";
import { normalizeClearance } from "../lib/permissions";
import { composioProxy, hasComposioAccount } from "./composio";

const API = "https://api.github.com";
const BATCH = 8;
const MAX_FILES = 150;
const EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml"]);

async function githubFetch(token: string, path: string): Promise<any> {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "volanos-second-brain" } });
  if (!response.ok) {
    let detail = `GitHub API error (${response.status})`;
    try { const body = await response.json() as any; if (body?.message) detail = `GitHub: ${body.message}`; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return response.json();
}

async function githubFetchForRecord(env: IntegrationEnv, record: NonNullable<Awaited<ReturnType<typeof loadIntegration>>>, path: string): Promise<any> {
  if (hasComposioAccount(record)) return composioProxy(env, record.credentials.connectedAccountId, path, [
    { name: "Accept", value: "application/vnd.github+json", in: "header" },
    { name: "X-GitHub-Api-Version", value: "2022-11-28", in: "header" },
  ]);
  return githubFetch(record.credentials.token, path);
}

function repoConfig(config: Record<string, unknown>): { repo: string; ref: string; prefix: string; extensions: Set<string> } | null {
  const repo = typeof config.repo === "string" ? config.repo.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const ref = typeof config.ref === "string" && config.ref.trim() ? config.ref.trim() : "main";
  const prefix = typeof config.path === "string" ? config.path.trim().replace(/^\/+|\/+$/g, "") : "";
  const extensions = Array.isArray(config.extensions) && config.extensions.every(x => typeof x === "string")
    ? new Set((config.extensions as string[]).map(x => x.startsWith(".") ? x.toLowerCase() : `.${x.toLowerCase()}`))
    : EXTENSIONS;
  return { repo, ref, prefix, extensions };
}

function options(config: Record<string, unknown>, path: string): MirrorEntryOptions {
  return {
    clearanceLevel: normalizeClearance(config.defaultClearance) ?? undefined,
    directoryId: typeof config.directoryId === "string" ? config.directoryId : null,
    sourcePath: path,
  };
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function listTree(fetcher: (path: string) => Promise<any>, cfg: { repo: string; ref: string; prefix: string; extensions: Set<string> }): Promise<{ items: any[]; complete: boolean }> {
  const tree = await fetcher(`/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.ref)}?recursive=1`);
  const items = (tree.tree ?? []).filter((item: any) => {
    if (item?.type !== "blob" || typeof item.path !== "string") return false;
    if (cfg.prefix && !(item.path === cfg.prefix || item.path.startsWith(`${cfg.prefix}/`))) return false;
    const dot = item.path.lastIndexOf(".");
    return dot >= 0 && cfg.extensions.has(item.path.slice(dot).toLowerCase());
  }).slice(0, MAX_FILES);
  return { items, complete: tree.truncated !== true && (tree.tree?.length ?? 0) <= MAX_FILES };
}

async function syncGithub(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome> {
  const provider = githubProvider;
  const record = await loadIntegration(env, provider.id);
  if (!record) return { ok: false, error: "GitHub is not connected" };
  const cfg = repoConfig(record.config);
  if (!cfg) return { ok: false, error: "GitHub requires config.repo in owner/repository format" };
  let listing: { items: any[]; complete: boolean };
  const fetcher = (path: string) => githubFetchForRecord(env, record, path);
  try { listing = await listTree(fetcher, cfg); } catch (e) {
    record.status = "error"; record.lastSyncError = e instanceof Error ? e.message : String(e); record.updatedAt = Date.now(); await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  }
  const changed = listing.items.filter(item => record.itemMap[item.path]?.version !== String(item.sha));
  const deleted = listing.complete ? Object.keys(record.itemMap).filter(path => !listing.items.some(item => item.path === path)) : [];
  const batch = changed.slice(0, BATCH);
  let created = 0, updated = 0, failed = 0;
  for (const item of batch) {
    try {
      const blob = await fetcher(`/repos/${cfg.repo}/git/blobs/${encodeURIComponent(item.sha)}`);
      const content = `# ${item.path}\nhttps://github.com/${cfg.repo}/blob/${encodeURIComponent(cfg.ref)}/${item.path}\n\n${decodeBase64(String(blob.content ?? ""))}`;
      const existing = record.itemMap[item.path];
      const itemOptions = options(record.config, item.path);
      if (existing && await store.updateEntry(existing.entryId, content, itemOptions)) updated++;
      else { const id = await store.createEntry(content, [provider.id, "source:github"], provider.id, itemOptions); record.itemMap[item.path] = { entryId: id, version: String(item.sha) }; created++; continue; }
      record.itemMap[item.path] = { entryId: existing?.entryId ?? "", version: String(item.sha) };
    } catch (e) { console.error(`GitHub sync failed for ${item.path} (non-fatal):`, e); failed++; }
  }
  let removed = 0;
  for (const path of deleted) {
    const mapped = record.itemMap[path]; if (!mapped) continue;
    try { await store.deleteEntry(mapped.entryId); delete record.itemMap[path]; removed++; } catch (e) { console.error(`GitHub mirror delete failed for ${path} (non-fatal):`, e); }
  }
  record.status = "connected"; record.lastSyncedAt = Date.now(); record.lastSyncError = null; record.updatedAt = Date.now(); await saveIntegration(env, record);
  return { ok: true, created, updated, deleted: removed, failed, remaining: changed.length - batch.length, total: listing.items.length };
}

export async function githubValidateToken(token: string): Promise<string> {
  const me = await githubFetch(token, "/user");
  return me?.login ? `GitHub @${me.login}` : "GitHub account";
}

export const githubProvider: IntegrationProvider = {
  id: "github",
  name: "GitHub",
  category: "knowledge",
  authKind: "oauth2",
  connectLabel: "Connect your GitHub account",
  connectPlaceholder: "OAuth connection",
  connectHint: "Authorize read-only repository access. The OAuth token is held by Composio and never returned to the dashboard.",
  validateToken: githubValidateToken,
  sync: syncGithub,
};
