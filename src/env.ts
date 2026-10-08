// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it.
export interface Env extends Omit<Cloudflare.Env, "VECTORIZE_GRACE_MS"> {
  VECTORIZE_GRACE_MS?: string;
  /** Project credential for Composio's server-to-server API. Never sent to the browser. */
  COMPOSIO_API_KEY?: string;
  /** Optional public callback URL; defaults to the current request origin locally. */
  COMPOSIO_CALLBACK_URL?: string;
  /** OpenRouter key (secret). Never sent to the browser. */
  OPENROUTER_API_KEY?: string;
  /** NVIDIA NIM key (secret). Never sent to the browser. */
  NVIDIA_API_KEY?: string;
  /** TypeSafe Jev key (secret) used by the ingest classifier. */
  JEV_API_KEY?: string;
  /** Fine-grained GitHub token (secret): Contents read/write on the ONE private export repository. */
  GITHUB_EXPORT_TOKEN?: string;
  /** TypeSafe key (secret) for the Jev reranker. Falls back to JEV_API_KEY (same vendor). */
  TYPESAFE_API_KEY?: string;
  /** Override for the Jev endpoint, mainly for tests. */
  JEV_API_URL?: string;
  /** Google OAuth client for Workspace login. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

// Worker version, echoed by GET /health. The desktop app compares this against
// the version it bundles to offer a one-click "update your Second Brain".
// Bump (semver) when the Worker changes; see installer/README "Worker versioning".
export const SB_VERSION = "3.1.0";
