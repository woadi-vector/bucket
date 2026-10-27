#!/usr/bin/env node
/**
 * Reconsideration state checks. Bundles src/lib/reconsideration.ts.
 *
 * This state machine decides which of two opposite sentences a person reads. `accepted` says
 * Bucket changed its mind; `held` says it did not. Both come off `explanationAccepted`, one
 * boolean, and a wrong branch would show someone the reverse of what was decided while
 * looking completely normal on screen. Nothing else in the app would notice.
 *
 * The silence rules matter as much. A withheld contest was judged not worth voicing and a
 * cached verdict was never a model's opinion at all, so neither may open this card. Those are
 * the same rules the server applies, restated here because this is a second place that can
 * decide to put an argument in front of someone.
 *
 *   npm run check:reconsideration
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
  throw new Error(`check-reconsideration: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/lib/reconsideration.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-reconsider-"));
const file = join(dir, "reconsideration.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const {
  EXPLANATION_LIMIT,
  canOverride,
  canSubmitExplanation,
  exchangeState,
  isLiveContest,
  remainingCharacters,
} = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

/** A spoken contest, the only verdict that opens this card. */
const contested = {
  agrees: false,
  verdict: "want",
  confidence: 0.82,
  reasoning: "Four of your last eight needs were convenience food.",
  question: "What made this one different?",
};

const accepted = { ...contested, agrees: true, verdict: "need", explanationAccepted: true };
const held = { ...contested, explanationAccepted: false };

// 1. Which verdicts may raise an argument. Each of these is a silence the app promised
//    somewhere else, and this is a second place that could break it.
{
  check("silence: nothing at all", isLiveContest(null) === false);
  check("silence: undefined", isLiveContest(undefined) === false);
  check("silence: an agreement", isLiveContest({ ...contested, agrees: true }) === false);
  check(
    "silence: a withheld contest",
    isLiveContest({ ...contested, withheld: true }) === false,
    "judged not worth saying, so nothing may appear",
  );
  check(
    "silence: a cached verdict",
    isLiveContest({ ...contested, cached: true, agrees: false }) === false,
    "nothing canned may argue with anyone",
  );
  check(
    "silence: a contest with no reasoning",
    isLiveContest({ ...contested, reasoning: "" }) === false,
    "an argument with nothing in it is not an argument",
  );
  check("speaks: a real contest", isLiveContest(contested) === true);
}

// 2. The opening state, and the fact that none of the silences reach it.
{
  check("state: a contest opens contested", exchangeState({ verdict: contested }) === "contested");
  check("state: no verdict is none", exchangeState({}) === "none");
  check(
    "state: an agreement is none",
    exchangeState({ verdict: { ...contested, agrees: true } }) === "none",
  );
  check(
    "state: a withheld contest is none",
    exchangeState({ verdict: { ...contested, withheld: true } }) === "none",
  );
  check(
    "state: a withheld contest stays none even mid-answer",
    exchangeState({ verdict: { ...contested, withheld: true }, answering: true }) === "none",
    "no local flag may reopen a silence",
  );
}

// 3. The two opposite outcomes. This is the pair worth the whole suite.
{
  check(
    "outcome: accepted when the explanation held",
    exchangeState({ verdict: contested, reconsideration: accepted }) === "accepted",
  );
  check(
    "outcome: held when it did not",
    exchangeState({ verdict: contested, reconsideration: held }) === "held",
  );
  check(
    "outcome: an absent flag is not an acceptance",
    exchangeState({ verdict: contested, reconsideration: { ...contested } }) === "held",
    "only an explicit true may tell someone Bucket changed its mind",
  );
}

// 4. Precedence. A result that already arrived outranks any flag left behind by a race, and
//    a request in flight outranks an editable box that has already been sent.
{
  check(
    "order: a settled answer beats a stale pending",
    exchangeState({ verdict: contested, reconsideration: accepted, pending: true }) === "accepted",
  );
  check(
    "order: a settled answer beats a stale answering",
    exchangeState({ verdict: contested, reconsideration: held, answering: true }) === "held",
  );
  check(
    "order: thinking beats answering",
    exchangeState({ verdict: contested, answering: true, pending: true }) === "thinking",
  );
  check(
    "order: answering alone",
    exchangeState({ verdict: contested, answering: true }) === "answering",
  );
}

// 5. The way out. Keeping the purchase has to stay reachable while Bucket is arguing, while
//    it is thinking, and above all after it has held its position: that is the moment a
//    person most needs to end it, and hiding it there is how advice turns into pressure.
{
  check("override: offered while contested", canOverride("contested") === true);
  check("override: offered while answering", canOverride("answering") === true);
  check("override: offered while thinking", canOverride("thinking") === true);
  check("override: offered after it holds", canOverride("held") === true, "the important one");
  check("override: nothing to override once accepted", canOverride("accepted") === false);
  check("override: nothing to override with no argument", canOverride("none") === false);
}

// 6. What may be sent. The limit matches the server's slice, so nothing is cut after the
//    person has read it back, and whitespace never buys a trip to the expensive tier.
{
  check("limit: matches the server", EXPLANATION_LIMIT === 1000);
  check("send: a real answer", canSubmitExplanation("The old ones broke.") === true);
  check("send: not an empty string", canSubmitExplanation("") === false);
  check("send: not whitespace", canSubmitExplanation("   \n\t ") === false);
  check("send: exactly at the limit", canSubmitExplanation("x".repeat(1000)) === true);
  check("send: not past it", canSubmitExplanation("x".repeat(1001)) === false);
  check(
    "send: trailing space does not push a full answer over",
    canSubmitExplanation("x".repeat(1000) + "  ") === true,
  );
}

// 7. The counter.
{
  check("counter: full allowance when empty", remainingCharacters("") === 1000);
  check("counter: counts down", remainingCharacters("abc") === 997);
  check("counter: zero at the limit", remainingCharacters("x".repeat(1000)) === 0);
  check(
    "counter: never negative",
    remainingCharacters("x".repeat(1200)) === 0,
    "the field cannot reach that state, so the counter must not describe it",
  );
}

// 8. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
