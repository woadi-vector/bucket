#!/usr/bin/env node
/**
 * Model-attribution checks. Bundles src/lib/attribution.ts and the display helper.
 *
 * Telemetry naming the model and its token cost stays server-side everywhere else in this
 * app. The contested card is the one deliberate exception, and it is narrow: model
 * identifiers only, so a person looking at a single disagreement can see that two different
 * models produced it. That is the claim the whole architecture rests on, and aggregate
 * numbers on /efficiency cannot demonstrate it case by case.
 *
 * Both rules here fail silently if broken. Attaching a name to an overruled verdict would
 * announce the disagreement the app deliberately decided not to voice, which is the only
 * place the restraint can leak. Attaching one to a degraded call would credit a model for a
 * fallback it never produced. Neither would break a build or show up on screen as an error.
 *
 *   npm run check:attribution
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-attribution: network call blocked (${String(url)})`);
};

const dir = mkdtempSync(join(tmpdir(), "bucket-attribution-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export { attributionFor, attributionFrom, isSpokenContest } from "@/lib/attribution";
export { shortModelName } from "@/lib/bucket-store";`,
);

const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  // `node` rather than `neutral`: bucket-store.ts imports icon components for the cards.
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const file = join(dir, "attribution.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { attributionFor, attributionFrom, isSpokenContest, shortModelName } = await import(
  pathToFileURL(file).href
);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";

const screened = { model: NANO, adapter: "token-factory", stage: "screening" };
const adjudicated = { model: ULTRA, adapter: "token-factory", stage: "adjudication" };

// 1. Which verdicts may be attributed at all. The overruled case is the one that matters:
//    it comes back agreeing with the person and is meant to look like any other agreement,
//    so a model name on it would reveal the contest that was deliberately dropped.
{
  check("spoken: a live contest qualifies", isSpokenContest({ agrees: false }) === true);
  check("spoken: an agreement does not", isSpokenContest({ agrees: true }) === false);
  check(
    "spoken: a withheld contest does not",
    isSpokenContest({ agrees: false, withheld: { reason: "unsure" } }) === false,
  );
  check(
    "spoken: an overruled contest does not",
    isSpokenContest({ agrees: true, withheld: { reason: "overruled" } }) === false,
    "agrees with the person, so it must read as an ordinary agreement",
  );
}

// 2. The entry point refuses to hand out names for anything but a spoken contest, so the
//    rule cannot be skipped by a caller that only wants the model names.
{
  const calls = [screened, adjudicated];
  check("gate: a live contest gets names", attributionFor({ agrees: false }, calls) !== undefined);
  check("gate: an agreement gets none", attributionFor({ agrees: true }, calls) === undefined);
  check(
    "gate: a withheld contest gets none",
    attributionFor({ agrees: false, withheld: { reason: "unsure" } }, calls) === undefined,
  );
  check(
    "gate: an overruled contest gets none",
    attributionFor({ agrees: true, withheld: { reason: "overruled" } }, calls) === undefined,
  );
}

// 3. The escalation, which is the thing worth showing: two models, named separately, in the
//    roles they actually played.
{
  const a = attributionFrom([screened, adjudicated]);
  check("escalated: the screening model is named", a?.screened === NANO);
  check("escalated: the adjudicating model is named", a?.adjudicated === ULTRA);
  check("escalated: the provider comes through", a?.provider === "token-factory");
  check(
    "escalated: order of the calls does not matter",
    attributionFrom([adjudicated, screened])?.screened === NANO,
  );
}

// 4. A screening-only verdict names one model and claims no escalation.
{
  const a = attributionFrom([screened]);
  check("screening only: named", a?.screened === NANO);
  check("screening only: no escalation claimed", a?.adjudicated === undefined);
  check(
    "screening only: an absent stage still counts as screening",
    attributionFrom([{ model: NANO, adapter: "token-factory" }])?.screened === NANO,
  );
}

// 5. Nothing that was not answered by a model. A fallback or a canned verdict carries a tier
//    for the ledger, and crediting a model for one would be a false claim.
{
  check(
    "unanswered: a degraded call is not attributed",
    attributionFrom([{ ...screened, degraded: true }]) === undefined,
  );
  check(
    "unanswered: a cached call is not attributed",
    attributionFrom([{ ...screened, cached: true }]) === undefined,
  );
  check("unanswered: no calls at all", attributionFrom([]) === undefined);
  check(
    "unanswered: a call with no model name",
    attributionFrom([{ adapter: "token-factory", stage: "screening" }]) === undefined,
  );
  check(
    "unanswered: a degraded screening with a real adjudication claims neither",
    attributionFrom([{ ...screened, degraded: true }, adjudicated]) === undefined,
    "no screening model means no attribution, rather than a half-told story",
  );
}

// 6. The provider is only named when an adapter reported one, so the card cannot credit
//    infrastructure that was not used. The stub must never read as Nebius.
{
  check(
    "provider: the stub is reported as the stub",
    attributionFrom([{ model: "stub-model", adapter: "stub", stage: "screening" }])?.provider ===
      "stub",
  );
  check(
    "provider: absent when the adapter did not say",
    attributionFrom([{ model: NANO, stage: "screening" }])?.provider === undefined,
  );
}

// 7. Display names. The raw identifier travels so the card can never name a model that did
//    not run; this only makes it readable, and an unknown id comes back verbose, not wrong.
{
  check(
    "display: the nano id shortens",
    shortModelName(NANO) === "Nemotron Nano",
    shortModelName(NANO),
  );
  check(
    "display: the ultra id shortens",
    shortModelName(ULTRA) === "Nemotron Ultra",
    shortModelName(ULTRA),
  );
  check(
    "display: an unknown model keeps its own name",
    shortModelName("vendor/some-new-model-v2") === "some-new-model-v2",
  );
  check("display: no vendor prefix is fine", shortModelName("plain-model") === "plain-model");
  check(
    "display: a nemotron with no size word is not guessed at",
    shortModelName("nvidia/Nemotron-3") === "Nemotron-3",
  );
  check("display: never returns empty for a real id", shortModelName(NANO).length > 0);
}

// 8. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
