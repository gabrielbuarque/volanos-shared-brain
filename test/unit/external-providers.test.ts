import { afterEach, describe, expect, it, vi } from "vitest";
import { driveProvider, driveValidateToken } from "../../src/integrations/drive";
import { githubProvider, githubValidateToken } from "../../src/integrations/github";
import { saveIntegration } from "../../src/integrations/framework";
import { makeMemoryKV } from "../helpers/make-env";

function mirrorStore() {
  const created: Array<{ content: string; tags: string[]; source: string; options?: unknown }> = [];
  return {
    created,
    createEntry: vi.fn(async (content: string, tags: string[], source: string, options?: unknown) => {
      created.push({ content, tags, source, options });
      return `entry-${created.length}`;
    }),
    updateEntry: vi.fn(async () => false),
    deleteEntry: vi.fn(async () => undefined),
  };
}

describe("GitHub and Google Drive providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates a GitHub token without exposing it", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe("https://api.github.com/user");
      return new Response(JSON.stringify({ login: "gabrielbuarque" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubValidateToken("github-secret")).resolves.toBe("GitHub @gabrielbuarque");
    expect(githubProvider.authKind).toBe("token");
  });

  it("mirrors a GitHub blob with Volanos security metadata", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/user")) return new Response(JSON.stringify({ login: "gabrielbuarque" }));
      if (input.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [{ type: "blob", path: "docs/brief.md", sha: "sha-1" }] }));
      }
      return new Response(JSON.stringify({ content: Buffer.from("conteudo Volanos").toString("base64") }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = { OAUTH_KV: makeMemoryKV() };
    await saveIntegration(env, {
      provider: "github", authKind: "token", credentials: { token: "github-secret" },
      config: { repo: "gabrielbuarque/volanos-shared-brain", ref: "main", defaultClearance: 4, directoryId: "dir-docs" },
      status: "connected", workspaceName: "Volanos", lastSyncedAt: null, lastSyncError: null,
      itemMap: {}, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const store = mirrorStore();

    const result = await githubProvider.sync(env, store);

    expect(result).toMatchObject({ ok: true, created: 1, updated: 0, deleted: 0, remaining: 0, total: 1 });
    expect(store.created[0]).toMatchObject({
      source: "github",
      tags: ["github", "source:github"],
      content: expect.stringContaining("conteudo Volanos"),
      options: { clearanceLevel: 4, directoryId: "dir-docs", sourcePath: "docs/brief.md" },
    });
  });

  it("validates Drive OAuth and mirrors a text file with source metadata", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/about?")) {
        return new Response(JSON.stringify({ user: { emailAddress: "ops@volanos.ai" } }), { headers: { "content-type": "application/json" } });
      }
      if (input.includes("/files?q=")) {
        return new Response(JSON.stringify({ files: [{ id: "file-1", name: "brief.md", mimeType: "text/markdown", modifiedTime: "2026-09-10T00:00:00Z", md5Checksum: "md5", webViewLink: "https://drive.google.com/file-1" }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response("conteudo do Drive", { headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(driveValidateToken("drive-secret")).resolves.toBe("ops@volanos.ai");
    expect(driveProvider.authKind).toBe("oauth2");

    const env = { OAUTH_KV: makeMemoryKV() };
    await saveIntegration(env, {
      provider: "google-drive", authKind: "oauth2", credentials: { token: "drive-secret" },
      config: { folderId: "folder-1", defaultClearance: 6, directoryId: "dir-drive" },
      status: "connected", workspaceName: "Volanos Drive", lastSyncedAt: null, lastSyncError: null,
      itemMap: {}, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const store = mirrorStore();

    const result = await driveProvider.sync(env, store);

    expect(result).toMatchObject({ ok: true, created: 1, updated: 0, deleted: 0, remaining: 0, total: 1 });
    expect(store.created[0]).toMatchObject({
      source: "google-drive",
      tags: ["google-drive", "source:google-drive"],
      content: expect.stringContaining("conteudo do Drive"),
      options: { clearanceLevel: 6, directoryId: "dir-drive", sourcePath: "brief.md" },
    });
  });
});
