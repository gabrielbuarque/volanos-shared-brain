/**
 * PageIndex-style reasoning over a document tree, ported to the Worker.
 *
 * Order matters and is the whole security argument: the caller's rows are read
 * through the permission filter FIRST (the SQL in routes/pageindex.ts), and only
 * then does anything here run. `pruneTree` therefore never sees a chunk the
 * caller may not read, and a node with no readable chunk disappears with its
 * title. Nothing in this file talks to the database or decides access.
 */

export interface ReadableChunk {
  nodeId: string;
  nodeTitle: string;
  nodePath: string;
  parentId: string | null;
  ord: number;
  entryId: string;
  content: string;
  clearance: number;
}

export interface PrunedNode {
  id: string;
  title: string;
  path: string;
  parentId: string | null;
  preview: string;
  chunks: ReadableChunk[];
}

export const MAX_NODES_CHOSEN = 3;
const PREVIEW_CHARS = 160;

/** Keep only nodes that still hold a readable chunk; order by position in the document. */
export function pruneTree(chunks: readonly ReadableChunk[]): PrunedNode[] {
  const nodes = new Map<string, PrunedNode>();
  for (const c of [...chunks].sort((a, b) => a.ord - b.ord)) {
    let n = nodes.get(c.nodeId);
    if (!n) {
      n = { id: c.nodeId, title: c.nodeTitle, path: c.nodePath, parentId: c.parentId, preview: "", chunks: [] };
      nodes.set(c.nodeId, n);
    }
    n.chunks.push(c);
  }
  for (const n of nodes.values()) n.preview = n.chunks[0].content.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
  return [...nodes.values()];
}

export function treePrompt(query: string, nodes: readonly PrunedNode[]): string {
  const lines = nodes.map(n => `${n.id} | ${n.path} | ${n.preview}`).join("\n");
  return `You navigate a document by its table of contents. Pick the sections most likely to answer the question.\n` +
    `Reply with ONLY a JSON object: {"node_ids": ["<id>", ...]} with at most ${MAX_NODES_CHOSEN} ids from the list.\n\n` +
    `Question: ${query.slice(0, 500)}\n\nSections (id | path | preview):\n${lines}`;
}

/** Accepts JSON or loose text; keeps only ids that exist in the pruned tree. */
export function parseNodeChoice(text: string, valid: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    const s = String(id).trim();
    if (valid.has(s) && !out.includes(s)) out.push(s);
  };
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const ids = JSON.parse(obj[0])?.node_ids;
      if (Array.isArray(ids)) ids.forEach(add);
    } catch { /* fall through to loose parse */ }
  }
  if (!out.length) for (const m of text.matchAll(/\b\d{4}\b/g)) add(m[0]);
  return out.slice(0, MAX_NODES_CHOSEN);
}

export function answerContext(nodes: readonly PrunedNode[], chosen: readonly string[]): { context: string; ids: string[] } {
  const picked = nodes.filter(n => chosen.includes(n.id));
  const ids: string[] = [];
  const blocks = picked.map((n, i) => {
    n.chunks.forEach(c => ids.push(c.entryId));
    return `[${i + 1}] ${n.path}\n${n.chunks.map(c => c.content).join("\n\n")}`;
  });
  return { context: blocks.join("\n\n---\n\n"), ids };
}

export const ANSWER_SYSTEM = `You answer using ONLY the sections provided. Cite each claim with the section number in square brackets, like [1]. If the sections do not contain the answer, say so.`;
