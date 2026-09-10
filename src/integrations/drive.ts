import type { IntegrationEnv, IntegrationProvider, MirrorEntryOptions, MirrorStore, SyncOutcome } from "./framework";
import { loadIntegration, saveIntegration } from "./framework";
import { normalizeClearance } from "../lib/permissions";

const API = "https://www.googleapis.com/drive/v3";
const BATCH = 8;
const MIME_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/x-javascript"]);

async function driveFetch(token: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!response.ok) {
    let detail = `Google Drive API error (${response.status})`;
    try { const body = await response.json() as any; if (body?.error?.message) detail = `Google Drive: ${body.error.message}`; } catch { /* keep status */ }
    throw new Error(detail);
  }
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? response.json() : response.text();
}

function options(config: Record<string, unknown>, path: string): MirrorEntryOptions {
  return { clearanceLevel: normalizeClearance(config.defaultClearance) ?? undefined, directoryId: typeof config.directoryId === "string" ? config.directoryId : null, sourcePath: path };
}

async function syncDrive(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome> {
  const provider = driveProvider;
  const record = await loadIntegration(env, provider.id);
  if (!record) return { ok: false, error: "Google Drive is not connected" };
  const folderId = typeof record.config.folderId === "string" && record.config.folderId.trim() ? record.config.folderId.trim() : "root";
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  let data: any;
  try { data = await driveFetch(record.credentials.token, `/files?q=${q}&pageSize=100&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,webViewLink,size)`); } catch (e) {
    record.status = "error"; record.lastSyncError = e instanceof Error ? e.message : String(e); record.updatedAt = Date.now(); await saveIntegration(env, record); return { ok: false, error: record.lastSyncError };
  }
  const files = (data.files ?? []).filter((file: any) => file?.id && (MIME_TEXT.has(file.mimeType) || file.mimeType === "application/vnd.google-apps.document"));
  const changed = files.filter((file: any) => record.itemMap[file.id]?.version !== `${file.modifiedTime ?? ""}:${file.md5Checksum ?? ""}`);
  const deleted = !data.nextPageToken ? Object.keys(record.itemMap).filter(id => !files.some((file: any) => file.id === id)) : [];
  const batch = changed.slice(0, BATCH);
  let created = 0, updated = 0, failed = 0;
  for (const file of batch) {
    try {
      const contentType = file.mimeType === "application/vnd.google-apps.document" ? "text/plain" : "";
      const suffix = contentType ? `/export?mimeType=${encodeURIComponent(contentType)}` : `?alt=media`;
      const body = await driveFetch(record.credentials.token, `/files/${encodeURIComponent(file.id)}${suffix}`);
      const path = String(file.name ?? file.id);
      const content = `# ${path}\n${file.webViewLink ?? ""}\n\n${String(body)}`;
      const version = `${file.modifiedTime ?? ""}:${file.md5Checksum ?? ""}`;
      const existing = record.itemMap[file.id];
      const itemOptions = options(record.config, path);
      if (existing && await store.updateEntry(existing.entryId, content, itemOptions)) updated++;
      else { const id = await store.createEntry(content, [provider.id, "source:google-drive"], provider.id, itemOptions); record.itemMap[file.id] = { entryId: id, version }; created++; continue; }
      record.itemMap[file.id] = { entryId: existing?.entryId ?? "", version };
    } catch (e) { console.error(`Google Drive sync failed for ${file.id} (non-fatal):`, e); failed++; }
  }
  let removed = 0;
  for (const fileId of deleted) { const mapped = record.itemMap[fileId]; if (!mapped) continue; try { await store.deleteEntry(mapped.entryId); delete record.itemMap[fileId]; removed++; } catch (e) { console.error(`Google Drive mirror delete failed for ${fileId} (non-fatal):`, e); } }
  record.status = "connected"; record.lastSyncedAt = Date.now(); record.lastSyncError = null; record.updatedAt = Date.now(); await saveIntegration(env, record);
  return { ok: true, created, updated, deleted: removed, failed, remaining: changed.length - batch.length, total: files.length };
}

export async function driveValidateToken(token: string): Promise<string> {
  const me = await driveFetch(token, "/about?fields=user(displayName,emailAddress)");
  return me?.user?.emailAddress ?? me?.user?.displayName ?? "Google Drive account";
}

export const driveProvider: IntegrationProvider = {
  id: "google-drive",
  name: "Google Drive",
  category: "knowledge",
  authKind: "oauth2",
  connectLabel: "Google Drive OAuth access token",
  connectPlaceholder: "ya29.…",
  connectHint: "Use a short-lived OAuth token with Drive read-only scope. Configure folderId, defaultClearance and optionally directoryId in the connection config.",
  validateToken: driveValidateToken,
  sync: syncDrive,
};
