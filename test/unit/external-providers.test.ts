import { afterEach, describe, expect, it, vi } from "vitest";
import { driveProvider, driveValidateToken } from "../../src/integrations/drive";
import { githubProvider, githubValidateToken } from "../../src/integrations/github";
import { makeEmailProvider } from "../../src/integrations/email";
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
    expect(githubProvider.authKind).toBe("oauth2");
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

  it("mirrors a Gmail OAuth message through Composio without storing a mail password", async () => {
    const raw = Buffer.from([
      "Message-ID: <gmail-1@example.com>",
      "From: Andre <andre@volanos.ai>",
      "Subject: Shared Brain", "Date: Tue, 10 Sep 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "",
      "Decisions from the meeting.",
    ].join("\r\n")).toString("base64url");
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/messages")) return new Response(JSON.stringify({ data: { messages: [{ id: "gmail-1" }] } }));
      if (request.endpoint.endsWith("/gmail-1") && request.parameters.some((p: any) => p.name === "format" && p.value === "metadata")) {
        return new Response(JSON.stringify({ data: { internalDate: "1789034400000", payload: { headers: [
          { name: "Message-ID", value: "<gmail-1@example.com>" }, { name: "From", value: "Andre <andre@volanos.ai>" },
          { name: "Subject", value: "Shared Brain" }, { name: "Date", value: "Tue, 10 Sep 2026 10:00:00 +0000" },
        ] } } }));
      }
      return new Response(JSON.stringify({ data: { raw } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const kv = makeMemoryKV();
    await saveIntegration({ OAUTH_KV: kv }, {
      provider: "email-gmail", authKind: "oauth2", credentials: { token: "", connectedAccountId: "ca-gmail" },
      config: {}, status: "connected", workspaceName: "Gmail OAuth", lastSyncedAt: null, lastSyncError: null,
      itemMap: {}, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const created: string[] = [];
    const store = {
      createEntry: vi.fn(async (content: string) => { created.push(content); return "entry-gmail-1"; }),
      updateEntry: vi.fn().mockResolvedValue(false), deleteEntry: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeEmailProvider({ id: "email-gmail", name: "Gmail", host: "imap.gmail.com", connectLabel: "", connectPlaceholder: "", connectHint: "", authKind: "oauth2" });
    const result = await provider.sync({ OAUTH_KV: kv, COMPOSIO_API_KEY: "composio-key" }, store);
    expect(result).toMatchObject({ ok: true, created: 1, failed: 0 });
    expect(created[0]).toContain("# Shared Brain");
    expect(JSON.stringify(await kv.get("integrations:email-gmail"))).not.toContain("appPassword");
  });
});
