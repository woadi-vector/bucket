#!/usr/bin/env node
/**
 * Runs Bucket's real payments module against the real PayPal sandbox.
 *
 * check-payments.mjs proves the logic against a fake. This proves the fake was honest: the same
 * code places a hold from the saved demo wallet, lets one go, captures another, and then asks
 * PayPal directly what state each authorization ended in.
 *
 *   npm run probe:paypal
 *
 * Needs three values, read from the environment or from .dev.vars (gitignored):
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   the sandbox app's credentials
 *   PAYPAL_DEMO_VAULT_ID                     the saved sandbox buyer wallet (payment token id)
 *
 * Sandbox only: the module refuses live unless PAYPAL_ENV is exactly "live", and this script
 * refuses to run at all if it is. Nothing secret is printed. Holds are stored in memory, so the
 * script leaves no rows anywhere, only two sandbox transactions.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const NAMES = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_DEMO_VAULT_ID", "PAYPAL_ENV"];
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
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
const missing = NAMES.slice(0, 3).filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Add them to .dev.vars (see .dev.vars.example).`);
  process.exit(1);
}

const bundle = async (entry) => {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    logLevel: "error",
    alias: { "@": resolve("src") },
  });
  const dir = mkdtempSync(join(tmpdir(), "bucket-probe-"));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, out.outputFiles[0].contents);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const payments = await bundle("src/lib/server/payments.ts");
const paypal = await bundle("src/lib/server/paypal.ts");

let failures = 0;
const step = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const vaultId = process.env.PAYPAL_DEMO_VAULT_ID;
const common = { sessionId: "probe", label: "Probe purchase", merchant: "Bucket probe", vaultId };

try {
  const want = await payments.placeHold({
    ...common,
    bucketId: "bucket-gear",
    bucketTag: "want",
    amountCents: 2499,
    verdict: "hold",
  });
  step("want placed as a hold", want.state === "held", `authorization ${want.authorizationId}`);

  const released = await payments.letGo(want.id, { decidedBy: "user" });
  const wantStatus = await paypal.getAuthorizationStatus(want.authorizationId);
  step(
    "let-go voided it at PayPal",
    released.ok && wantStatus === "VOIDED",
    `PayPal says ${wantStatus}`,
  );

  const need = await payments.placeHold({
    ...common,
    bucketId: "bucket-groceries",
    bucketTag: "need",
    amountCents: 1250,
    verdict: "pass",
  });
  const needStatus = await paypal.getAuthorizationStatus(need.authorizationId);
  step(
    "need captured with no pause",
    need.state === "captured" && needStatus === "CAPTURED",
    `PayPal says ${needStatus}, capture ${need.captureId}`,
  );
} catch (error) {
  failures++;
  console.error(`FAIL  ${error.name}: ${error.message}`);
}

console.log(failures === 0 ? "\nSandbox agrees with Bucket." : `\n${failures} step(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
