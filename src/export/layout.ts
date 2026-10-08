/**
 * Where a memory's file lives in the export repository:
 *
 *   <workspace>/<directory path>/<slug>-<short id>.md
 *   _history/<workspace>/<short id>/v0003.md        (earlier versions)
 *
 * Everything is derived from the memory, so the same memory always maps to the
 * same path and an edit that changes the title moves the file instead of
 * duplicating it (the short id is how the exporter recognises it).
 */

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export function slugify(text: string, max = 60): string {
  const slug = fold(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/g, "");
}

/** Ten alphanumeric characters taken from the end of the id (the random part of every id we mint). */
export function shortId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return clean.slice(-10) || "x";
}

export function titleOf(content: string): string {
  const first = content.split("\n").map(l => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first || "sem título";
}

export function workspaceFolder(w: { id: string; name?: string | null; kind?: string | null }): string {
  const name = slugify(w.name ?? "") || (w.kind === "company" ? "empresa" : "pessoal");
  // Personal workspaces are named after a person, and two people can share a name.
  return w.kind === "company" ? name : `${name}-${shortId(w.id).slice(0, 6)}`;
}

export function directoryFolders(path: string | null | undefined): string[] {
  const segments = (path ?? "").split("/").map(s => slugify(s)).filter(Boolean);
  return segments.length ? segments : ["_geral"];
}

export function entryPath(args: {
  workspace: { id: string; name?: string | null; kind?: string | null };
  directoryPath?: string | null;
  content: string;
  id: string;
}): string {
  const slug = slugify(titleOf(args.content)) || "memoria";
  return [workspaceFolder(args.workspace), ...directoryFolders(args.directoryPath), `${slug}-${shortId(args.id)}.md`].join("/");
}

export function historyPath(workspaceFolderName: string, id: string, version: number): string {
  return `_history/${workspaceFolderName}/${shortId(id)}/v${String(version).padStart(4, "0")}.md`;
}

/** The short id embedded in an entry file name, or null when the path is not an entry file. */
export function shortIdFromPath(path: string): string | null {
  if (path.startsWith("_history/") || !path.endsWith(".md")) return null;
  const m = /-([a-z0-9]{1,10})\.md$/.exec(path.slice(path.lastIndexOf("/") + 1));
  return m ? m[1] : null;
}

export function isHistoryPath(path: string): boolean {
  return path.startsWith("_history/") && /\/v\d+\.md$/.test(path);
}
