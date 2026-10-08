/**
 * Markdown → section tree → paragraph chunks.
 *
 * The tree mirrors PageIndex's Markdown mode (`md_to_tree`): one node per
 * heading, children nested by heading depth. Each node owns the paragraphs that
 * sit directly under its heading. Pure functions only, so the ingest pipeline
 * and the tests share them.
 */

export const CHUNK_MAX_CHARS = 1600;

export interface TreeNode {
  /** Stable within the document: "0001", "0002"… in reading order. */
  id: string;
  parentId: string | null;
  title: string;
  depth: number;
  /** Titles from the root to this node, joined with " > ". */
  path: string;
  ord: number;
}

export interface Chunk {
  nodeId: string;
  /** Position of the chunk in the document. */
  index: number;
  /** Section path, kept as context for the classifier and for retrieval. */
  path: string;
  text: string;
}

export interface ParsedDocument {
  nodes: TreeNode[];
  chunks: Chunk[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

/** Collapse Windows line endings and runs of blank lines; strip NUL. */
export function normalizeMarkdown(input: string): string {
  return input.replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split an over-long paragraph on sentence ends, then hard-wrap what is still too long. */
export function splitLong(text: string, max = CHUNK_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) push();
    cur = cur ? `${cur} ${s}` : s;
  }
  push();
  return out;
}

export function parseMarkdown(markdown: string, fallbackTitle = "Documento"): ParsedDocument {
  const lines = normalizeMarkdown(markdown).split("\n");
  const nodes: TreeNode[] = [];
  const chunks: Chunk[] = [];
  const stack: TreeNode[] = [];
  let current: TreeNode | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const newNode = (title: string, depth: number): TreeNode => {
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const node: TreeNode = {
      id: String(nodes.length + 1).padStart(4, "0"),
      parentId: parent?.id ?? null,
      title,
      depth,
      path: parent ? `${parent.path} > ${title}` : title,
      ord: nodes.length,
    };
    nodes.push(node);
    stack.push(node);
    return node;
  };

  const flush = () => {
    if (!buffer.length) return;
    if (!current) current = newNode(fallbackTitle, 0);
    const node: TreeNode = current;
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    for (const piece of splitLong(text)) chunks.push({ nodeId: node.id, index: chunks.length, path: node.path, text: piece });
  };

  for (const line of lines) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const h = !inFence ? HEADING.exec(line) : null;
    if (h) {
      flush();
      current = newNode(h[2].trim(), h[1].length);
      continue;
    }
    // Blank line ends a paragraph, except inside a code fence.
    if (!inFence && line.trim() === "") { flush(); continue; }
    buffer.push(line);
  }
  flush();
  return { nodes, chunks };
}

/** Nodes that hold at least one chunk, plus every ancestor of those. */
export function nodesWithContent(doc: ParsedDocument): TreeNode[] {
  const keep = new Set<string>();
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  for (const c of doc.chunks) {
    let n: TreeNode | undefined = byId.get(c.nodeId);
    while (n && !keep.has(n.id)) { keep.add(n.id); n = n.parentId ? byId.get(n.parentId) : undefined; }
  }
  return doc.nodes.filter(n => keep.has(n.id));
}

/** PageIndex only pays off on long, structured documents (PRD: ≥3 sections or >8000 chars). */
export function worthTree(doc: ParsedDocument): boolean {
  const total = doc.chunks.reduce((n, c) => n + c.text.length, 0);
  return nodesWithContent(doc).length >= 3 || total > 8000;
}
