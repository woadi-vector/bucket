/**
 * Access to the Cloudflare Workers `env` (bindings + secrets) from server code.
 *
 * `src/server.ts` is the Workers entry and is the only place that receives `env`, so it
 * hands it here on every request. Storing it at module scope is safe: `env` is the same
 * object for every request in an isolate.
 *
 * In `npm run dev` there is no Workers runtime, so this is undefined. Callers must handle
 * that rather than assume a binding exists.
 */

export type CloudflareEnv = {
  BUCKET_DB?: D1Database;
  NEBIUS_API_KEY?: string;
  [key: string]: unknown;
};

/** Minimal shape of the D1 binding — avoids depending on @cloudflare/workers-types. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

let cloudflareEnv: CloudflareEnv | undefined;

export function setCloudflareEnv(env: unknown): void {
  if (env && typeof env === "object") {
    cloudflareEnv = env as CloudflareEnv;
  }
}

/**
 * Nitro's cloudflare-module preset wraps our entry and does not forward `(request, env, ctx)`
 * to it, so the env captured in src/server.ts stays empty in production — verified by
 * probing a real build. The generated entry does assign `globalThis.__env__ = env` on every
 * request, so that is the binding source that actually works. The captured value is kept as
 * a fallback in case the entry wiring changes.
 */
export function getCloudflareEnv(): CloudflareEnv | undefined {
  const fromNitro = (globalThis as { __env__?: CloudflareEnv }).__env__;
  if (fromNitro && typeof fromNitro === "object") return fromNitro;
  return cloudflareEnv;
}

/** The D1 binding, or undefined when running outside the Workers runtime. */
export function getDb(): D1Database | undefined {
  return getCloudflareEnv()?.BUCKET_DB;
}

/**
 * A server-side secret, from whichever runtime we are in.
 *
 * Production: a Workers secret set with `wrangler secret put NAME`, reached through
 * `globalThis.__env__`. Development: `process.env`, which the Vite config populates from
 * `.dev.vars` — `npm run dev` is plain Node and does not read that file itself.
 *
 * Server-only. Nothing that reaches the browser may import this.
 */
export function getSecret(name: string): string | undefined {
  return getEnvVar(name);
}

/**
 * A Workers `vars` entry or secret, falling back to `process.env` in development.
 *
 * Wrangler passes `vars` through the same env object as secrets, but a var written as a JSON
 * number arrives as a number, so both are normalised to strings here.
 */
export function getEnvVar(name: string): string | undefined {
  const fromWorkers = getCloudflareEnv()?.[name];
  if (typeof fromWorkers === "string" && fromWorkers) return fromWorkers;
  if (typeof fromWorkers === "number" && Number.isFinite(fromWorkers)) return String(fromWorkers);

  if (typeof process !== "undefined" && process.env) {
    const fromNode = process.env[name];
    if (typeof fromNode === "string" && fromNode) return fromNode;
  }
  return undefined;
}
