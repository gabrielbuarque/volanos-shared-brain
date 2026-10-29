import { describe, it, expect, vi } from "vitest";

const { compressTag } = vi.hoisted(() => ({ compressTag: vi.fn().mockResolvedValue({ synthesizedId: null, entriesUsed: 0, text: "" }) }));
vi.mock("../../src/compression/digest", () => ({ compressTag }));

import { runNightlyCompression } from "../../src/compression/nightly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestDb, makeTestEnv, makeMemoryKV } from "../helpers/make-env";

describe("runNightlyCompression workspace slice", () => {
  it("passes the slice to compressTag so only that workspace is scanned", async () => {
    resetDatabaseInit();
    const db = makeTestDb();
    const old = Date.now() - 200 * 24 * 3600 * 1000;
    for (let i = 0; i < 12; i++) {
      db.entries.push({ id: `e${i}`, content: "m", tags: JSON.stringify(["topic-a"]), source: "api", created_at: old, updated_at: old, vector_ids: "[]", workspace_id: "w1", recall_count: 0, importance_score: 0, contradiction_wins: 0 });
    }
    const env = makeTestEnv(db, { OAUTH_KV: makeMemoryKV() });
    await runNightlyCompression(env, { waitUntil() {} } as any, "w1");
    expect(compressTag).toHaveBeenCalledWith("topic-a", env, expect.anything(), { workspaceIds: ["w1"] });
  });
});
