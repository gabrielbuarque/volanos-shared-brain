import type { Env } from "../env";
import { resolveConfig } from "../config";
import { deleteStaleVectors, reembedOrDegrade } from "../capture/store";
import { snapshotAndBump } from "./versions";

/**
 * Troca o texto de uma memória preservando as quebras de linha.
 *
 * `POST /update` passa o texto por `extractHashtags`, que achata toda a pontuação de espaço:
 * um documento com cabeçalhos e listas viraria uma linha só. Para o Canon isso é perda, então
 * a edição de documento passa por aqui: o texto antigo vai para `entry_versions` (mesmo caminho
 * da restauração), o novo entra como está e o índice vetorial é refeito.
 *
 * O chamador já decidiu que pode editar (leitura com escopo + papel, ou aprovação de quem lê o nível).
 */
export async function applyDocumentEdit(env: Env, entryId: string, content: string, actorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    // scope-exempt: by-id: callers gate with a scoped read (selectScopedEntries) before calling this
    `SELECT tags, source, vector_ids, workspace_id, clearance_level, directory_id, source_path FROM entries WHERE id = ?`,
  ).bind(entryId).first<{ tags: string | null; source: string; vector_ids: string | null; workspace_id: string; clearance_level: number | null; directory_id: string | null; source_path: string | null }>();
  if (!row) return false;

  await snapshotAndBump(env, entryId, { actorId, reason: "edit" });
  await env.DB.prepare(`UPDATE entries SET content = ?, updated_at = ? WHERE id = ?`).bind(content, Date.now(), entryId).run();

  // O texto já está salvo; se o índice não acompanhar agora, a busca por palavra continua achando.
  try {
    const cfg = await resolveConfig(env);
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    const stored = await reembedOrDegrade(env, entryId, content, tags, row.source, cfg, {
      workspaceId: row.workspace_id, actorId, clearanceLevel: row.clearance_level ?? 12, directoryId: row.directory_id, sourcePath: row.source_path,
    });
    if (stored) await deleteStaleVectors(env, JSON.parse(row.vector_ids ?? "[]"), stored.vectorIds);
  } catch (e) {
    console.error("applyDocumentEdit: re-embed failed (non-fatal, text is saved):", e);
  }
  return true;
}
