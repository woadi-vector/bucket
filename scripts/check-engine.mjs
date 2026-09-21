#!/usr/bin/env node
/**
 * Engine checks. Bundles src/engine on its own and runs judgeTransaction against fake adapters.
 *
 * Nothing here reaches Token Factory, and nothing is spent. Every adapter is an in-process fixture,
 * and global `fetch` is replaced with one that throws and is counted, so an accidental network
 * call fails the run instead of going out.
 *
 * Bundling the engine separately is itself part of the check: it must build without the rest of
 * the app (see "The verdict engine is a separate thing from the app" in the README).
 *
 *   npm run check:engine
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Refuse the network before the engine is even loaded.
let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-engine: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/engine/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
});
const dir = mkdtempSync(join(tmpdir(), "bucket-engine-"));
const file = join(dir, "engine.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { judgeTransaction, CACHED_REASONING } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

const request = {
  purchase: { amount: 260, label: "Headphones", intent: "need", readinessTag: "impulse" },
  history: [],
};

// Counts every call and always contests the user's tag, so escalation is always warranted.
function countingAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      name: "fixture",
      async complete(req) {
        calls.push(req.model);
        return {
          text: '{"verdict":"want","confidence":0.9,"reasoning":"You call comforts needs."}',
          usage: { promptTokens: 300, completionTokens: 300, totalTokens: 600 },
        };
      },
    },
  };
}

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

// 1. Ceiling already reached: no model call at all, cached verdict that agrees.
{
  const { calls, adapter } = countingAdapter();
  const usage = [];
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    onUsage: (e) => usage.push(e),
    checkCeiling: () => ({ reached: true, reason: "tokens 5000000/5000000" }),
  });
  check("tripped: adapter never called", calls.length === 0, `calls=${calls.length}`);
  check("tripped: nothing recorded to the ledger", usage.length === 0);
  check("tripped: marked cached", v.cached === true && v.telemetry?.cached === true);
  check("tripped: agrees with the user", v.agrees === true && v.verdict === "need");
  check("tripped: reasoning says it is cached", v.reasoning === CACHED_REASONING);
  check("tripped: zero confidence", v.confidence === 0);
}

// 2. Under the ceiling: normal path, screening + escalation both happen.
{
  const { calls, adapter } = countingAdapter();
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    checkCeiling: () => ({ reached: false }),
  });
  check("under: both tiers called", calls.length === 2, calls.join(" -> "));
  check("under: not marked cached", !v.cached);
}

// 3. Ceiling trips after screening: keep the paid-for screening verdict, skip Ultra.
{
  const { calls, adapter } = countingAdapter();
  let asked = 0;
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    checkCeiling: () => (++asked === 1 ? { reached: false } : { reached: true, reason: "x" }),
  });
  check("mid-trip: only screening called", calls.length === 1, calls.join(" -> "));
  check("mid-trip: ceiling asked twice", asked === 2, `asked=${asked}`);
  check("mid-trip: real screening verdict kept", v.cached !== true && v.verdict === "want");
}

// 4. The ceiling check itself throws: fail CLOSED — no call, cached verdict.
//    The engine logs the error; that console.error line is expected output.
{
  const { calls, adapter } = countingAdapter();
  const v = await judgeTransaction(request, {
    adapter,
    checkCeiling: () => {
      throw new Error("ledger unavailable (expected in this check)");
    },
  });
  check("throwing check: fails closed, no call", calls.length === 0, `calls=${calls.length}`);
  check("throwing check: serves cached verdict", v.cached === true && v.agrees === true);
}

// 5. No checkCeiling supplied: behaves exactly as before.
{
  const { calls, adapter } = countingAdapter();
  await judgeTransaction(request, { adapter });
  check("no hook: unchanged behaviour", calls.length === 1);
}

// 6. The guard itself: nothing above touched the network.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
