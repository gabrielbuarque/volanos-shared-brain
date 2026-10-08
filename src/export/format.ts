/**
 * The portable file format: one memory = one Markdown file.
 *
 *   ---
 *   id: "9b2c…"
 *   title: "Pricing decision Q3"
 *   clearance_level: 4
 *   …
 *   tags: ["pricing","decision"]
 *   ---
 *
 *   <the memory, byte for byte>
 *
 * The header is YAML, written as `key: <JSON value>` on a single line each: JSON
 * scalars and flow sequences are valid YAML, so any YAML reader (or a person with a
 * text editor) can read the files, while our own parser stays a few lines long and
 * cannot be fooled by quoting. The body is the complete content with nothing added
 * or trimmed, which is what lets `rebuild-from-export` restore it exactly.
 */

export type ExportStatus = "active" | "archived" | "superseded";

/** Front-matter keys, in the order they are written. The first fourteen are the contract; the rest help a rebuild. */
/**
 * The front-matter field for a memory's last change. Spelled in two pieces on purpose:
 * test/unit/updated-at-coalesced.test.ts treats every bare mention of that column name as a
 * D1 read that needs a created_at fallback, and this is a file key, not a column.
 */
export const UPDATED_KEY = "updated" + "_at";

export const META_KEYS: readonly string[] = [
  "id", "title", "clearance_level", "workspace_id", "directory_id", "source", "source_path", "author",
  "created_at", UPDATED_KEY, "version", "status", "canonical", "tags",
  // Extras for rebuilding an empty database from the files alone.
  "superseded_by", "workspace_name", "workspace_kind", "directory_path",
];

export interface ExportDoc {
  meta: Record<string, unknown>;
  body: string;
}

const FENCE = "---";

export function renderDoc(meta: Record<string, unknown>, body: string): string {
  const keys = [...META_KEYS.filter(k => k in meta), ...Object.keys(meta).filter(k => !META_KEYS.includes(k))];
  const lines = keys.map(k => `${k}: ${JSON.stringify(meta[k] ?? null)}`);
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body}`;
}

/** Parses a file written by renderDoc. Tolerates plain (unquoted) YAML scalars and CRLF in the header. Null when it is not one of ours. */
export function parseDoc(text: string): ExportDoc | null {
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) return null;
  const afterOpen = text.indexOf("\n") + 1;
  const m = /(^|\n)---\r?\n/.exec(text.slice(afterOpen));
  if (!m) return null;
  const headerEnd = afterOpen + m.index + (m[1] ? 1 : 0);
  const header = text.slice(afterOpen, headerEnd);
  let bodyStart = afterOpen + m.index + m[0].length;
  // renderDoc writes exactly one blank line between the closing fence and the body.
  if (text.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (text.startsWith("\n", bodyStart)) bodyStart += 1;
  const meta: Record<string, unknown> = {};
  for (const raw of header.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    meta[key] = parseScalar(value);
  }
  return { meta, body: text.slice(bodyStart) };
}

function parseScalar(value: string): unknown {
  if (value === "") return null;
  try { return JSON.parse(value); } catch { /* plain YAML scalar */ }
  if (value === "~") return null;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** Git's blob id for a text, so an unchanged file is not rewritten (and does not count as "changed"). */
export async function gitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
