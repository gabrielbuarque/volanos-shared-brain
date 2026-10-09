import type { Env } from "../env";
import type { Identity } from "./identity";
import { readableWorkspaces } from "./scope";
import { selectScopedEntries } from "./scoped-entries";
import { findDivergences } from "../aging/text";

/**
 * Clientes do Shared Brain.
 *
 * Um cliente é um diretório do Shared Brain (`brain_directories`): o `directory_id` das
 * memórias é o `client_id`. Memória sem diretório pertence ao "Volanos interno".
 * O escopo de cliente SOMA-SE ao filtro de nível, de workspace e à ACL de diretório
 * (todos dentro do SQL, antes do ORDER BY/LIMIT): ele só estreita, nunca amplia.
 */

export const INTERNAL_CLIENT = "internal";

/** Predicado de cliente, para entrar no WHERE de `entries` (coluna sem alias). */
export function clientPredicate(clientId: string): { clause: string; bindings: string[] } {
  return clientId === INTERNAL_CLIENT
    ? { clause: "directory_id IS NULL", bindings: [] }
    : { clause: "directory_id = ?", bindings: [clientId] };
}

/** Lê e valida o parâmetro ?client=. Vazio = sem escopo de cliente. */
export function parseClientParam(raw: string | null | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  return v.length <= 120 ? v : undefined;
}

export type ReviewState = "draft" | "reviewed" | "verified";

/**
 * Estado de revisão a partir das tags que já existem: `status:canonical` = verificado,
 * tag `approved` (publicado pela fila de aprovação) = revisado, `status:draft` = rascunho.
 * Sem nenhuma delas: null, que a interface lê como "não revisado".
 */
export function reviewStateOf(tags: readonly string[]): ReviewState | null {
  if (tags.includes("status:canonical")) return "verified";
  if (tags.includes("approved")) return "reviewed";
  if (tags.includes("status:draft")) return "draft";
  return null;
}

/** Fonte antiga: sem atualização há mais que AGING_COLD_DAYS (o mesmo corte do memory aging). */
export function isStaleSource(updatedAt: number, coldDays: number, now = Date.now(), staleAsOf = false): boolean {
  return staleAsOf || now - updatedAt > coldDays * 86_400_000;
}

export interface SourceConflict {
  a: string;
  b: string;
  metric: string;
  a_value: string;
  b_value: string;
  origin: "aging" | "live";
}

/**
 * Pares de fontes DO RESULTADO que dizem a mesma coisa com valores diferentes.
 * Só olha para fontes que já foram devolvidas à pessoa (portanto já legíveis por ela):
 * nenhum par traz uma fonte que ela não pode ler. Une o que a rotina semanal de
 * contradições já registrou (aging_suggestions) com uma análise por regras na hora,
 * sem modelo, para funcionar mesmo com a rotina desligada.
 */
export async function findSourceConflicts(
  env: Env,
  sources: readonly { id: string; content: string }[],
): Promise<SourceConflict[]> {
  const out = new Map<string, SourceConflict>();
  const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const ids = sources.map((s) => s.id);
  if (ids.length > 1) {
    const marks = ids.map(() => "?").join(", ");
    try {
      const { results } = await env.DB.prepare(
        `SELECT a_id, b_id, detail FROM aging_suggestions WHERE kind = 'contradiction' AND status = 'open' AND a_id IN (${marks}) AND b_id IN (${marks})`,
      ).bind(...ids, ...ids).all<{ a_id: string; b_id: string; detail: string }>();
      for (const r of results ?? []) {
        let d: { metric?: string; a_values?: string[]; b_values?: string[] } = {};
        try { d = JSON.parse(r.detail); } catch { /* detalhe ilegível: o par ainda vale */ }
        out.set(key(r.a_id, r.b_id), { a: r.a_id, b: r.b_id, metric: d.metric ?? "", a_value: (d.a_values ?? [])[0] ?? "", b_value: (d.b_values ?? [])[0] ?? "", origin: "aging" });
      }
    } catch { /* tabela ausente em banco antigo: só a análise ao vivo */ }
  }
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (out.has(key(sources[i].id, sources[j].id))) continue;
      const [d] = findDivergences(sources[i].content, sources[j].content);
      if (d) out.set(key(sources[i].id, sources[j].id), { a: sources[i].id, b: sources[j].id, metric: d.a, a_value: d.aValues[0] ?? "", b_value: d.bValues[0] ?? "", origin: "live" });
    }
  }
  return [...out.values()];
}

export interface ClientRow {
  id: string;
  name: string;
  path: string;
  owner: { id: string; name: string } | null;
  sources: number;
  updated_at: number | null;
}

/**
 * Clientes que a pessoa acessa. A contagem e a data vêm só de memórias que ela pode ler
 * (nível, workspace e ACL no SQL). Quem não é admin só vê um cliente onde lê ao menos uma
 * fonte: um cliente cujo conteúdo está todo acima do nível dela não aparece nem como nome.
 */
export async function listAccessibleClients(env: Env, identity: Identity): Promise<{ clients: ClientRow[]; internal: { sources: number; updated_at: number | null } }> {
  const counts = await selectScopedEntries<{ directory_id: string | null; n: number; last: number | null }>(env, identity, {
    select: `directory_id, COUNT(*) AS n, MAX(COALESCE(updated_at, created_at)) AS last`,
    where: "tags NOT LIKE '%\"status:deprecated\"%'",
    groupBy: "directory_id",
  });
  const byDir = new Map(counts.map((c) => [c.directory_id, c]));
  const workspaces = readableWorkspaces(identity);
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.name, d.path, d.owner_id, u.name AS owner_name FROM brain_directories d
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.workspace_id IN (${workspaces.map(() => "?").join(", ")}) ORDER BY d.name COLLATE NOCASE`,
  ).bind(...workspaces).all<{ id: string; name: string; path: string; owner_id: string; owner_name: string | null }>();
  const clients: ClientRow[] = [];
  for (const d of results ?? []) {
    const c = byDir.get(d.id);
    if (!c && identity.role !== "admin") continue;
    clients.push({ id: d.id, name: d.name, path: d.path, owner: d.owner_id ? { id: d.owner_id, name: d.owner_name ?? "" } : null, sources: Number(c?.n ?? 0), updated_at: c?.last ?? null });
  }
  const internal = byDir.get(null);
  return { clients, internal: { sources: Number(internal?.n ?? 0), updated_at: internal?.last ?? null } };
}
