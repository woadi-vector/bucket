import type { VerdictAttribution } from "@/lib/bucket-store";

/**
 * Deciding what a contested card may say about which models produced it.
 *
 * Pure, and separate from the server function that uses it, because two of the rules here
 * are the kind that fail silently. One governs whether a model name is attached at all,
 * and getting it wrong would announce a disagreement the app deliberately decided not to
 * voice. The other skips calls that no model answered, and getting it wrong would credit a
 * model for a fallback. Neither failure would break anything or show up in a build.
 */

/** The shape of a model call's telemetry that matters here. */
export type AttributableCall = {
  model?: string;
  adapter?: string;
  stage?: "screening" | "adjudication" | "reconsideration";
  degraded?: boolean;
  cached?: boolean;
};

/** The parts of a verdict that decide whether it was a contest the person was shown. */
export type AttributableVerdict = {
  agrees: boolean;
  withheld?: unknown;
};

/**
 * Whether this verdict is a disagreement the person actually sees.
 *
 * Three verdicts reach here and only one qualifies. An agreement never opens the contested
 * card. A withheld contest was judged not worth saying, and its whole value is that the
 * person is not shown it. An overruled contest comes back agreeing with the person and is
 * meant to be indistinguishable from any other agreement, so attaching an escalation to it
 * would announce the argument that was dropped: the one place the restraint could leak.
 */
export function isSpokenContest(verdict: AttributableVerdict): boolean {
  const hidden = Boolean(verdict.withheld) && !verdict.agrees;
  return !verdict.agrees && !hidden;
}

/**
 * Model identifiers pulled out of the per-call telemetry.
 *
 * Built from the calls rather than from the returned verdict because the engine returns one
 * verdict while two calls may have produced it: an adjudication's telemetry records the tier
 * it escalated from, not the screening model's identity. The per-call hook is the only place
 * both names are known.
 *
 * Degraded and cached calls are skipped. Both mean no model produced the answer, and naming
 * one for a fallback would be a false claim of exactly the kind this exists to substantiate.
 */
export function attributionFrom(calls: AttributableCall[]): VerdictAttribution | undefined {
  const answered = calls.filter(
    (c): c is AttributableCall & { model: string } =>
      !c.degraded && !c.cached && typeof c.model === "string" && c.model.length > 0,
  );

  // `stage` is documented as screening unless stated, so an absent stage counts as one.
  const screening = answered.find((c) => c.stage === undefined || c.stage === "screening");
  const adjudication = answered.find((c) => c.stage === "adjudication");

  if (!screening) return undefined;

  return {
    screened: screening.model,
    ...(adjudication ? { adjudicated: adjudication.model } : {}),
    ...(screening.adapter ? { provider: screening.adapter } : {}),
  };
}

/**
 * The attribution a response may carry, or nothing.
 *
 * The single entry point the server uses, so the spoken-contest rule cannot be forgotten at
 * a call site: a caller that wants model names has to come through the check.
 */
export function attributionFor(
  verdict: AttributableVerdict,
  calls: AttributableCall[],
): VerdictAttribution | undefined {
  if (!isSpokenContest(verdict)) return undefined;
  return attributionFrom(calls);
}
