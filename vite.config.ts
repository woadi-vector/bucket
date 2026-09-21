// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

/**
 * Loads `.dev.vars` into `process.env` for the dev server only.
 *
 * `.dev.vars` is a wrangler file. `npm run dev` runs a plain Node Vite server with no Workers
 * runtime, so nothing reads it and every server-side secret would be undefined in development.
 *
 * This runs in the Vite process and assigns to `process.env`, which is server-side only. It
 * deliberately does NOT go through `define` or `import.meta.env` — either of those would inline
 * the secret into the client bundle, which is the one thing the plan says must never happen.
 * It is also gated to dev, so a production build cannot pick it up.
 */
function devVarsPlugin(): Plugin {
  return {
    name: "bucket:dev-vars",
    apply: "serve",
    config() {
      if (!existsSync(".dev.vars")) return;
      const loaded: string[] = [];
      for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        const value = rawValue.trim().replace(/^["']|["']$/g, "");
        if (value && !process.env[key]) {
          process.env[key] = value;
          loaded.push(key);
        }
      }
      // Names only, never values — this line goes to a terminal someone may screen-share.
      if (loaded.length > 0) {
        console.log(`  [dev-vars] loaded from .dev.vars: ${loaded.join(", ")}`);
      }
    },
  };
}

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    plugins: [devVarsPlugin()],
  },
});
