import type { Intent, Verdict, Withheld } from "./types";

/**
 * Whether a disagreement is worth interrupting someone about.
 *
 * Bucket contests a person's own word about their own money. That is the whole product, and
 * it is also the thing that makes an app like this unbearable: a tool that objects to
 * everything gets closed and never opened again. So disagreeing and speaking up are two
 * separate decisions, and this file owns the second one.
 *
 * Both reasons for keeping quiet are recorded rather than discarded. A silence nobody can
 * count is indistinguishable from an app that simply never disagreed, which is the claim
 * this module would otherwise be making about itself.
 */

/**
 * The confidence a sustained contest must clear before it reaches the person.
 *
 * Asymmetric, because the two directions are not the same act. Telling someone the thing
 * they called a need is really a want is a challenge, and being wrong about it is
 * insulting; telling someone the thing they called a want was closer to a need is close to
 * a kindness, and being wrong about it costs them nothing. The harsher direction has to be
 * more sure of itself.
 *
 * These are floors on a number the model reports about itself, which is the weakest kind of
 * evidence in the system and is why {@link Withheld} records the reason separately: an
 * `overruled` silence rests on two models disagreeing, an `unsure` one rests only on this.
 */
export const FLOOR_CONTESTING_A_NEED = 0.8;
export const FLOOR_CONTESTING_A_WANT = 0.65;

/**
 * The floor that applies to a contest, chosen by which way it cuts.
 *
 * A contested verdict of `want` can only mean the person said `need`, since a verdict that
 * matched their tag would not be a contest at all. So the verdict alone names the direction
 * and the user's tag does not need to be passed in.
 */
export function floorFor(verdict: Intent): number {
  return verdict === "want" ? FLOOR_CONTESTING_A_NEED : FLOOR_CONTESTING_A_WANT;
}

/**
 * Decides whether a sustained contest is said out loud.
 *
 * Returns the reason for silence, or `undefined` when Bucket should speak. Agreement is not
 * this function's business: there is nothing to withhold when there was no argument.
 *
 * A degraded verdict never reaches here, because {@link judgeTransaction} returns early on
 * one. If that ever changes, note that a verdict produced by a failed call has no business
 * contesting anybody and should be treated as `unsure`.
 */
export function withholdSustained(verdict: Verdict): Withheld | undefined {
  if (verdict.agrees) return undefined;
  if (verdict.confidence >= floorFor(verdict.verdict)) return undefined;

  return {
    reason: "unsure",
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
  };
}

/**
 * Records that the expensive tier took the person's side against the cheap one.
 *
 * Called with the two verdicts rather than deciding anything, because the decision was
 * already made by the models: the returned verdict agrees with the person, so there is
 * nothing to show either way. What this adds is the memory that an argument happened and
 * was dropped, which is the part a log is worth reading for.
 */
export function withholdOverruled(screening: Verdict): Withheld {
  return {
    reason: "overruled",
    verdict: screening.verdict,
    confidence: screening.confidence,
    reasoning: screening.reasoning,
  };
}
