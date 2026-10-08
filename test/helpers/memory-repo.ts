import { gitBlobSha } from "../../src/export/format";
import type { ExportRepo, RepoChange, RepoFile, RepoSnapshot } from "../../src/export/repo";

/** An in-memory stand-in for the export repository, with a commit log. */
export class MemoryRepo implements ExportRepo {
  files = new Map<string, string>();
  commits: { message: string; changes: RepoChange[] }[] = [];
  reads = 0;
  failNextCommit = false;

  describe(): string { return "memory/test@main"; }

  async snapshot(): Promise<RepoSnapshot> {
    const files: RepoFile[] = [];
    for (const [path, content] of this.files) files.push({ path, sha: await gitBlobSha(content) });
    return { commit: `c${this.commits.length}`, tree: `t${this.commits.length}`, files, truncated: false };
  }

  async commit(_base: RepoSnapshot, changes: RepoChange[], message: string): Promise<string> {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error("push refused"); }
    for (const c of changes) {
      if (c.content === null) this.files.delete(c.path);
      else this.files.set(c.path, c.content);
    }
    this.commits.push({ message, changes });
    return `c${this.commits.length}`;
  }

  async read(file: RepoFile): Promise<string> {
    this.reads++;
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error(`no such file ${file.path}`);
    return content;
  }

  /** Paths of the memory files (not history), sorted. */
  entryPaths(): string[] { return [...this.files.keys()].filter(p => !p.startsWith("_history/")).sort(); }
  historyPaths(): string[] { return [...this.files.keys()].filter(p => p.startsWith("_history/")).sort(); }
}
