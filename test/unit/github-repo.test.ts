import { describe, expect, it } from "vitest";
import { GitHubRepo, RepoError } from "../../src/export/repo";

type Call = { method: string; path: string; body?: any; headers: Record<string, string> };

function fakeGitHub(opts: { branchMissing?: boolean; failRef?: boolean } = {}) {
  const calls: Call[] = [];
  const respond = (data: unknown, status = 200) => new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/repos/o/r", "");
    const call: Call = { method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(call);
    if (path.startsWith("/git/ref/heads/")) return opts.branchMissing ? respond({ message: "Not Found" }, 404) : respond({ object: { sha: "HEAD1" } });
    if (path === "/git/commits/HEAD1") return respond({ tree: { sha: "TREE1" } });
    if (path.startsWith("/git/trees/TREE1")) return respond({ tree: [{ path: "a/x.md", type: "blob", sha: "S1" }, { path: "a", type: "tree", sha: "T" }], truncated: false });
    if (path === "/git/trees" && call.method === "POST") return respond({ sha: `TREE${calls.filter(c => c.path === "/git/trees").length + 1}` });
    if (path === "/git/commits" && call.method === "POST") return respond({ sha: "HEAD2" });
    if (path.startsWith("/git/refs/heads/")) return opts.failRef ? respond({ message: "Update is not a fast forward" }, 422) : respond({});
    if (path.startsWith("/git/blobs/")) return respond("raw file text");
    return respond({ message: "unexpected" }, 500);
  }) as unknown as typeof fetch;
  return { calls, repo: new GitHubRepo("tok", "o/r", "main", fetchImpl) };
}

describe("GitHubRepo", () => {
  it("reads the branch tip and lists only files", async () => {
    const { repo, calls } = fakeGitHub();
    const snap = await repo.snapshot();
    expect(snap).toMatchObject({ commit: "HEAD1", tree: "TREE1", truncated: false, files: [{ path: "a/x.md", sha: "S1" }] });
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("makes ONE commit: inline-content trees, deletes as sha:null, a fast-forward-only ref update", async () => {
    const { repo, calls } = fakeGitHub();
    const snap = await repo.snapshot();
    const changes = Array.from({ length: 200 }, (_, i) => ({ path: `w/f${i}.md`, content: `text ${i}` }));
    changes.push({ path: "w/old.md", content: null as unknown as string });
    const sha = await repo.commit(snap, changes, "export: 200 novas, 0 alteradas, 0 arquivadas");
    expect(sha).toBe("HEAD2");
    const trees = calls.filter(c => c.method === "POST" && c.path === "/git/trees");
    expect(trees).toHaveLength(2);
    expect(trees[0].body.base_tree).toBe("TREE1");
    expect(trees[1].body.base_tree).toBe("TREE2");
    expect(trees[0].body.tree[0]).toMatchObject({ path: "w/f0.md", mode: "100644", type: "blob", content: "text 0" });
    expect(trees[1].body.tree.at(-1)).toMatchObject({ path: "w/old.md", sha: null });
    expect(calls.filter(c => c.path === "/git/blobs").length).toBe(0);
    const commits = calls.filter(c => c.method === "POST" && c.path === "/git/commits");
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toMatchObject({ message: "export: 200 novas, 0 alteradas, 0 arquivadas", tree: "TREE3", parents: ["HEAD1"] });
    const ref = calls.find(c => c.method === "PATCH")!;
    expect(ref.body).toEqual({ sha: "HEAD2", force: false });
  });

  it("surfaces a refused ref update and an empty repository clearly", async () => {
    const refused = fakeGitHub({ failRef: true });
    await expect(refused.repo.commit(await refused.repo.snapshot(), [{ path: "a.md", content: "x" }], "m")).rejects.toThrow(/fast forward/);
    const empty = fakeGitHub({ branchMissing: true });
    await expect(empty.repo.snapshot()).rejects.toThrow(/initial commit/);
  });

  it("reads a file as raw text and validates the repository name", async () => {
    const { repo } = fakeGitHub();
    expect(await repo.read({ path: "a/x.md", sha: "S1" })).toBe("raw file text");
    expect(() => new GitHubRepo("t", "not a repo", "main")).toThrow(RepoError);
  });
});
