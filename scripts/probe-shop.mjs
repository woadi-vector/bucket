#!/usr/bin/env node
/**
 * Sends the real shopping agent out once: real Channel3 search, real Nemotron choice and screen,
 * real PayPal sandbox hold. check-shop.mjs proves the rules against fakes; this proves the fakes
 * match the services.
 *
 *   npm run probe:shop
 *   npm run probe:shop -- "wireless earbuds" 120
 *
 * Arguments: what to shop for, and a price ceiling in dollars (default 90).
 *
 * Reads CHANNEL3_API_KEY, NEBIUS_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and
 * PAYPAL_DEMO_VAULT_ID from the environment or .dev.vars. NEBIUS_API_KEY is optional: without it
 * the agent falls back to the top result. Sandbox only. State lives in memory, so the run leaves
 * one sandbox transaction behind and nothing else. A held purchase is voided at the end so the
 * sandbox wallet is not left with an open hold.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const NAMES = [
  "CHANNEL3_API_KEY",
  "NEBIUS_API_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_DEMO_VAULT_ID",
  "PAYPAL_ENV",
];
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && NAMES.includes(m[1]) && !process.env[m[1]]) {
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v) process.env[m[1]] = v;
    }
  }
}
if (process.env.PAYPAL_ENV === "live") {
  console.error("Refusing to run: PAYPAL_ENV is set to live. This probe is for the sandbox.");
  process.exit(1);
}
const required = [
  "CHANNEL3_API_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_DEMO_VAULT_ID",
];
const missing = required.filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Add them to .dev.vars (see .dev.vars.example).`);
  process.exit(1);
}
if (!process.env.NEBIUS_API_KEY) {
  console.log("NEBIUS_API_KEY not set: the agent will take the top result without a model.\n");
}

const request = process.argv[2] ?? "running shoes";
const maxDollars = Number(process.argv[3] ?? 90);

async function bundle(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    logLevel: "error",
    alias: { "@": resolve("src") },
    external: ["lucide-react", "react", "react/*"],
    mainFields: ["module", "main"],
  });
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  const dir = mkdtempSync(join(resolve("node_modules/.cache"), "bucket-probe-"));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, out.outputFiles[0].contents);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shop = await bundle("src/lib/server/shop.ts");
const payments = await bundle("src/lib/server/payments.ts");
const persistence = await bundle("src/lib/bucket/persistence.ts");
const store = await bundle("src/lib/server/store.ts");

const sessionId = crypto.randomUUID();
await store.getStore().save(sessionId, persistence.createSeededState());

console.log(`Shopping for "${request}" under $${maxDollars.toFixed(2)}...\n`);
const r = await shop.runShop({ sessionId, request, maxPriceCents: Math.round(maxDollars * 100) });

if (!r.ok && r.reason === "declined") {
  console.log(`Considered   ${r.considered} products from Channel3`);
  console.log(`Declined     ${r.message}`);
  console.log("\nThe agent looked and bought nothing. Nothing reached PayPal.");
  process.exit(0);
}
if (!r.ok) {
  console.log(`FAIL  ${r.reason}: ${r.message}`);
  process.exit(1);
}

const dollars = (c) => `$${(c / 100).toFixed(2)}`;
console.log(`Considered   ${r.considered} products from Channel3`);
console.log(
  `Chose        ${r.product.title} (${dollars(r.product.priceCents)}, ${r.product.merchant})`,
);
console.log(`Category     ${r.product.category ?? "(none from Channel3)"}`);
console.log(`Agent        ${r.agent.degraded ? "[fallback] " : ""}${r.agent.reason}`);
console.log(
  `Filed under  ${r.bucket.name} (a ${r.bucket.tag}, holds at ${dollars(r.bucket.holdThresholdCents)})`,
);
console.log(
  `Screen       ${r.screen.ran ? `${r.screen.agrees ? "agrees" : "doubts it"}: ${r.screen.reasoning || "(no reasoning)"}` : r.screen.why}`,
);
if (r.screen.ran && r.screen.question) console.log(`Would ask    ${r.screen.question}`);
console.log(`Policy       ${r.policy.decision}: ${r.policy.reason}`);
console.log(`PayPal       authorization ${r.hold.authorizationId}, now ${r.hold.state}`);

if (r.hold.state === "held") {
  const released = await payments.letGo(r.hold.id, { decidedBy: "user" });
  console.log(`Cleanup      let it go: ${released.ok ? released.hold.state : released.reason}`);
}
console.log("\nThe agent ran end to end against the real services.");
