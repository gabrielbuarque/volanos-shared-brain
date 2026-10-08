import type { Env } from "../env";
import { resolveConfig } from "../config";
import { runScheduledIntegrationSync } from "../integrations/mirror";
import { runExport, exportTarget } from "../export/run";
import { agingFlag, runAgingJob } from "../aging/jobs";
import { hourlySlot } from "./slots";

/**
 * The hourly :30 invocation. Most hours it syncs one integration; at the hours
 * named in ./slots.ts it runs the export or one of the weekly aging passes
 * instead, when that job is switched on. A job that is off hands the hour back
 * to the sync, so turning features off costs nothing.
 */
export async function runHourlySlot(env: Env, scheduledTime: number | Date = Date.now()): Promise<void> {
  const slot = hourlySlot(scheduledTime);
  if (slot !== "integration-sync") {
    const cfg = await resolveConfig(env);
    if (slot === "export" && exportTarget(env, cfg)) { await runExport(env); return; }
    if (slot === "aging-dedup" && agingFlag(cfg, "dedup")) { await runAgingJob(env, "dedup"); return; }
    if (slot === "aging-contradictions" && agingFlag(cfg, "contradictions")) { await runAgingJob(env, "contradictions"); return; }
    if (slot === "aging-compact" && agingFlag(cfg, "compact")) { await runAgingJob(env, "compact"); return; }
  }
  await runScheduledIntegrationSync(env);
}
