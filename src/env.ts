// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it.
export interface Env extends Omit<Cloudflare.Env, "VECTORIZE_GRACE_MS"> {
  VECTORIZE_GRACE_MS?: string;
  /** Project credential for Composio's server-to-server API. Never sent to the browser. */
  COMPOSIO_API_KEY?: string;
  /** Optional public callback URL; defaults to the current request origin locally. */
  COMPOSIO_CALLBACK_URL?: string;
}

// Worker version, echoed by GET /health. The desktop app compares this against
// the version it bundles to offer a one-click "update your Second Brain".
// Bump (semver) when the Worker changes; see installer/README "Worker versioning".
export const SB_VERSION = "3.1.0";
