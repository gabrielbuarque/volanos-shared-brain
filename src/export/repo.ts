/**
 * The export repository, behind a small interface so the exporter and the
 * rebuild can be tested without GitHub.
 *
 * GitHubRepo talks to the Git Data API with a fine-grained token
 * (`GITHUB_EXPORT_TOKEN`, Contents: read and write on ONE private repository).
 * It is deliberately separate from the read-only GitHub integration: that one
 * belongs to a member's OAuth connection, this one writes the whole brain.
 * A commit is built as: new tree(s) on top of the branch's tree (file contents
 * go inline, so there is no blob call per file), one commit, one ref update.
 */

const API = "https://api.github.com";
/** Files per tree request, and a cap on inline bytes, so a request stays well inside GitHub's limits. */
const TREE_CHUNK_FILES = 150;
const TREE_CHUNK_BYTES = 4 * 1024 * 1024;

export interface RepoFile { path: string; sha: string }
export interface RepoSnapshot { commit: string; tree: string; files: RepoFile[]; truncated: boolean }
export interface RepoChange { path: string; content: string | null }

export interface ExportRepo {
  describe(): string;
  /** The tip of the branch and every file under it. */
  snapshot(): Promise<RepoSnapshot>;
  /** One commit holding every change (content null = delete). Returns the new commit sha. */
  commit(base: RepoSnapshot, changes: RepoChange[], message: string): Promise<string>;
  read(file: RepoFile): Promise<string>;
}

export class RepoError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export class GitHubRepo implements ExportRepo {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly branch: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new RepoError("the export repository must be owner/repository");
  }

  describe(): string { return `${this.repo}@${this.branch}`; }

  private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await this.fetchImpl(`${API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "volanos-shared-brain-export",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `GitHub API ${res.status}`;
      try { const j = await res.json() as { message?: string }; if (j?.message) detail = `GitHub: ${j.message}`; } catch { /* keep status */ }
      throw new RepoError(detail, res.status);
    }
    return res;
  }

  async snapshot(): Promise<RepoSnapshot> {
    let ref: { object?: { sha?: string } };
    try {
      ref = await (await this.call("GET", `/git/ref/heads/${encodeURIComponent(this.branch)}`)).json() as typeof ref;
    } catch (e) {
      if (e instanceof RepoError && (e.status === 404 || e.status === 409)) {
        throw new RepoError(`Branch "${this.branch}" not found (or the repository is empty). Create the repository with an initial commit (for example a README) and retry.`, e.status);
      }
      throw e;
    }
    const commit = ref.object?.sha;
    if (!commit) throw new RepoError("GitHub returned no commit for the branch");
    const c = await (await this.call("GET", `/git/commits/${commit}`)).json() as { tree?: { sha?: string } };
    const tree = c.tree?.sha;
    if (!tree) throw new RepoError("GitHub returned no tree for the commit");
    const t = await (await this.call("GET", `/git/trees/${tree}?recursive=1`)).json() as { tree?: { path: string; type: string; sha: string }[]; truncated?: boolean };
    const files = (t.tree ?? []).filter(i => i.type === "blob").map(i => ({ path: i.path, sha: i.sha }));
    return { commit, tree, files, truncated: t.truncated === true };
  }

  async commit(base: RepoSnapshot, changes: RepoChange[], message: string): Promise<string> {
    let tree = base.tree;
    let batch: Record<string, unknown>[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const res = await (await this.call("POST", "/git/trees", { base_tree: tree, tree: batch })).json() as { sha?: string };
      if (!res.sha) throw new RepoError("GitHub returned no tree sha");
      tree = res.sha;
      batch = [];
      bytes = 0;
    };
    for (const change of changes) {
      const size = change.content === null ? 0 : change.content.length * 2;
      if (batch.length >= TREE_CHUNK_FILES || (batch.length && bytes + size > TREE_CHUNK_BYTES)) await flush();
      batch.push(change.content === null
        ? { path: change.path, mode: "100644", type: "blob", sha: null }
        : { path: change.path, mode: "100644", type: "blob", content: change.content });
      bytes += size;
    }
    await flush();
    const commit = await (await this.call("POST", "/git/commits", { message, tree, parents: [base.commit] })).json() as { sha?: string };
    if (!commit.sha) throw new RepoError("GitHub returned no commit sha");
    // Not forced: if someone pushed meanwhile this is refused and the run reports it, rather than overwriting their work.
    await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  async read(file: RepoFile): Promise<string> {
    const res = await this.call("GET", `/git/blobs/${file.sha}`, undefined, "application/vnd.github.raw+json");
    return res.text();
  }
}
