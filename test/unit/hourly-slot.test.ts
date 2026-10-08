/**
 * The hourly :30 invocation hands its hour to the export or a weekly aging pass
 * only when that job is switched on; otherwise the integration sync keeps the hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn();
const exportRun = vi.fn();
const agingRun = vi.fn();
vi.mock("../../src/integrations/mirror", async (orig) => ({ ...(await orig<typeof import("../../src/integrations/mirror")>()), runScheduledIntegrationSync: (...a: unknown[]) => sync(...a) }));
vi.mock("../../src/export/run", async (orig) => ({ ...(await orig<typeof import("../../src/export/run")>()), runExport: (...a: unknown[]) => exportRun(...a) }));
vi.mock("../../src/aging/jobs", async (orig) => ({ ...(await orig<typeof import("../../src/aging/jobs")>()), runAgingJob: (...a: unknown[]) => agingRun(...a) }));

import { runHourlySlot } from "../../src/runtime/hourly";
import { CONFIG_KEY } from "../../src/config";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

const at = (iso: string) => new Date(iso).getTime();
async function envWith(config: Record<string, unknown>, secrets: Partial<Env> = {}): Promise<Env> {
  const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV(), ...secrets });
  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(config));
  return env;
}

beforeEach(() => { sync.mockReset(); exportRun.mockReset(); agingRun.mockReset(); });

describe("runHourlySlot", () => {
  it("runs the export at 06:30 UTC when a repository and token are set, and not the sync", async () => {
    await runHourlySlot(await envWith({ EXPORT_REPO: "volanos/brain-export" }, { GITHUB_EXPORT_TOKEN: "t" }), at("2026-10-07T06:30:00Z"));
    expect(exportRun).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it("gives the hour back to the sync when the export has no repository or no token", async () => {
    await runHourlySlot(await envWith({ EXPORT_REPO: "volanos/brain-export" }), at("2026-10-07T06:30:00Z"));
    await runHourlySlot(await envWith({}, { GITHUB_EXPORT_TOKEN: "t" }), at("2026-10-07T06:30:00Z"));
    expect(exportRun).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("runs each weekly pass on Sunday at its hour, only when its switch is on", async () => {
    await runHourlySlot(await envWith({ AGING_DEDUP: "on" }), at("2026-10-04T07:30:00Z"));
    await runHourlySlot(await envWith({ AGING_CONTRADICTIONS: "on" }), at("2026-10-04T08:30:00Z"));
    await runHourlySlot(await envWith({ AGING_COMPACT: "on" }), at("2026-10-04T09:30:00Z"));
    expect(agingRun.mock.calls.map(c => c[1])).toEqual(["dedup", "contradictions", "compact"]);
    expect(sync).not.toHaveBeenCalled();

    agingRun.mockReset();
    await runHourlySlot(await envWith({}), at("2026-10-04T07:30:00Z")); // switched off
    await runHourlySlot(await envWith({ AGING_DEDUP: "on" }), at("2026-10-05T07:30:00Z")); // a Monday
    expect(agingRun).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("every other hour is the integration sync, as before", async () => {
    await runHourlySlot(await envWith({ EXPORT_REPO: "o/r", AGING_DEDUP: "on" }, { GITHUB_EXPORT_TOKEN: "t" }), at("2026-10-07T13:30:00Z"));
    expect(sync).toHaveBeenCalledTimes(1);
    expect(exportRun).not.toHaveBeenCalled();
    expect(agingRun).not.toHaveBeenCalled();
  });
});
