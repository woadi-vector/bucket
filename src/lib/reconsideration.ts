import type { PurchaseVerdict } from "@/lib/bucket-store";

/**
 * The shape of the conversation on a contested purchase.
 *
 * Bucket disagrees, asks one question, and the person may answer it. That exchange has five
 * readable states and they are derived here rather than stored, because a stored state is a
 * second source of truth that can disagree with the verdict it describes. Everything below
 * is a function of what the engine returned plus whether a request is in flight.
 *
 * Two of these states are opposites that look similar in code and nothing on screen would
 * reveal the mistake: `accepted` tells someone Bucket changed its mind, `held` tells them it
 * did not. Both are driven by `explanationAccepted`, which the server derives from the new
 * verdict rather than taking from the model, and a wrong branch here would show a person the
 * reverse of what was actually decided while looking entirely normal.
 */

export type ExchangeState =
  /** Nothing to show. No verdict, an agreement, or a contest Bucket chose not to voice. */
  | "none"
  /** Bucket disagrees and has said why. Its question is waiting. */
  | "contested"
  /** The person is writing an answer. */
  | "answering"
  /** The answer is with the expensive tier. */
  | "thinking"
  /** The explanation held. Bucket changed its mind. */
  | "accepted"
  /** The explanation did not change it. The verdict stands, and so does the override. */
  | "held";

/** How long an explanation may be. The server slices to the same number. */
export const EXPLANATION_LIMIT = 1000;

export type ExchangeInput = {
  verdict?: PurchaseVerdict | null;
  reconsideration?: PurchaseVerdict | null;
  /** The person opened the answer box. */
  answering?: boolean;
  /** A reconsideration request is in flight. */
  pending?: boolean;
};

/**
 * Whether a verdict is a disagreement the person is actually shown.
 *
 * Matches the server's rule exactly. A withheld contest was judged not worth saying and its
 * whole value is that nothing appears, so it must not open a card here either. A cached
 * verdict always agrees, and is checked for its own sake rather than trusted to arrive with
 * `agrees` already true: nothing canned may ever raise an argument in front of someone.
 */
export function isLiveContest(verdict: PurchaseVerdict | null | undefined): boolean {
  if (!verdict) return false;
  if (verdict.agrees) return false;
  if (verdict.withheld) return false;
  if (verdict.cached) return false;
  return Boolean(verdict.reasoning);
}

/**
 * Which state the card is in.
 *
 * Order matters. A returned reconsideration is terminal and outranks both local flags, so a
 * stale `pending` or `answering` left behind by a race cannot hide an answer that already
 * arrived. `pending` outranks `answering` so the box does not stay editable under a request
 * that has already gone.
 */
export function exchangeState(input: ExchangeInput): ExchangeState {
  if (!isLiveContest(input.verdict)) return "none";

  const settled = input.reconsideration;
  if (settled) return settled.explanationAccepted ? "accepted" : "held";

  if (input.pending) return "thinking";
  if (input.answering) return "answering";
  return "contested";
}

/**
 * Whether an explanation is worth spending the expensive tier on.
 *
 * Whitespace is not an answer, and sending one would charge for a round trip whose only
 * possible outcome is the engine accepting an empty string. The cap matches the server's so
 * nothing is silently truncated after the person has read it back.
 */
export function canSubmitExplanation(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= EXPLANATION_LIMIT;
}

/**
 * What is left of the person's allowance, for the counter under the box.
 *
 * Never negative. The input is capped at the limit, and a counter that could run below zero
 * would be describing a state the field cannot reach.
 */
export function remainingCharacters(text: string): number {
  return Math.max(0, EXPLANATION_LIMIT - text.length);
}

/**
 * Whether the override is offered.
 *
 * Every state except the two where it would be meaningless. Keeping the purchase has to stay
 * one tap away while Bucket is arguing, while it is thinking, and especially after it has
 * held its position: that is the moment the person most needs to be able to end it, and
 * making them hunt for the way out is how advice turns into pressure.
 */
export function canOverride(state: ExchangeState): boolean {
  return state !== "none" && state !== "accepted";
}
