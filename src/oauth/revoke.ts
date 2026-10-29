import type { Env } from "../env";

/** Cuts every credential a user holds besides the users.token_hash: sessions and OAuth grants/tokens (keys `grant:<uid>:*`, `token:<uid>:*`). */
export async function revokeAllAccess(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM member_sessions WHERE user_id = ?`).bind(userId).run();
  for (const prefix of [`grant:${userId}:`, `token:${userId}:`]) {
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_KV.list({ prefix, cursor });
      await Promise.all(page.keys.map(k => env.OAUTH_KV.delete(k.name)));
      cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
    } while (cursor);
  }
}
