/**
 * What the hourly :30 invocation does, by the hour it fires.
 *
 * The free Workers plan allows five cron triggers and wrangler.jsonc already uses
 * all five, so the daily export and the weekly aging passes cannot each get their
 * own. They ride the hourly integration-sync trigger instead: at their hour that
 * invocation runs the job rather than the sync, and a skipped sync is picked up
 * by the next hour's invocation (the same property the maintenance branch relies
 * on). Each job also keeps its own D1/subrequest budget this way.
 *
 *   06:30 UTC every day   export to the private repository   (03:30 America/Fortaleza, UTC-3 all year)
 *   07:30 UTC Sundays     near-duplicate suggestions          (AGING_DEDUP)
 *   08:30 UTC Sundays     contradiction alerts                (AGING_CONTRADICTIONS)
 *   09:30 UTC Sundays     compaction of cold notes            (AGING_COMPACT)
 *
 * A job whose switch is off hands its hour back to the integration sync.
 */
export type HourlySlot = "export" | "aging-dedup" | "aging-contradictions" | "aging-compact" | "integration-sync";

export const EXPORT_HOUR_UTC = 6;
export const AGING_HOURS_UTC = { dedup: 7, contradictions: 8, compact: 9 } as const;

export function hourlySlot(scheduledTime: number | Date): HourlySlot {
  const d = typeof scheduledTime === "number" ? new Date(scheduledTime) : scheduledTime;
  const hour = d.getUTCHours();
  if (hour === EXPORT_HOUR_UTC) return "export";
  if (d.getUTCDay() === 0) {
    if (hour === AGING_HOURS_UTC.dedup) return "aging-dedup";
    if (hour === AGING_HOURS_UTC.contradictions) return "aging-contradictions";
    if (hour === AGING_HOURS_UTC.compact) return "aging-compact";
  }
  return "integration-sync";
}
