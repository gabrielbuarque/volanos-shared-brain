import type { Env } from "../env";

/**
 * Background-job bookkeeping. Every automatic run (export, the weekly aging
 * passes) leaves one `job_runs` row so the memory-health tab can show what ran,
 * when, and with what outcome, and every automatic change to a memory goes to the
 * audit log under an author of the form `system:<job-name>`.
 */

export const SYSTEM_ACTOR_PREFIX = "system:";
export const systemActor = (job: string): string => `${SYSTEM_ACTOR_PREFIX}${job}`;
export const isSystemActor = (actor: string): boolean => actor.startsWith(SYSTEM_ACTOR_PREFIX);

export interface JobRun {
  id: string;
  job: string;
  actor_id: string;
  started_at: number;
  finished_at: number;
  ok: number;
  summary: string;
}

/** Never throws: a lost bookkeeping row must not fail the job that just finished. */
export async function recordJobRun(
  env: Env,
  run: { job: string; actorId: string; startedAt: number; ok: boolean; summary: Record<string, unknown> },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO job_runs (id, job, actor_id, started_at, finished_at, ok, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), run.job, run.actorId, run.startedAt, Date.now(), run.ok ? 1 : 0, JSON.stringify(run.summary).slice(0, 4000)).run();
  } catch (e) {
    console.error("job_runs insert failed (non-fatal):", e);
  }
}

export async function recentJobRuns(env: Env, limit = 20): Promise<(Omit<JobRun, "summary"> & { summary: unknown })[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, job, actor_id, started_at, finished_at, ok, summary FROM job_runs ORDER BY started_at DESC LIMIT ?`,
  ).bind(limit).all();
  return ((results ?? []) as unknown as JobRun[]).map(r => {
    let summary: unknown = {};
    try { summary = JSON.parse(r.summary); } catch { /* keep {} */ }
    return { ...r, summary };
  });
}
