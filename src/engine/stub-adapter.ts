import type { CompletionRequest, CompletionResponse, ModelAdapter } from "./adapter";
import type { Intent } from "./types";

export const STUB_REASONING =
  "Stub verdict — no model has been consulted. Phase 3 replaces this with a real Token Factory call.";

/**
 * Markers that force the stub's answer, for design and UI work without an API key.
 *
 * Put one in a purchase's label or note. `#want` or `#need` forces the verdict, so tagging a
 * purchase `need` and writing `#want` produces a disagreement and raises the retraction
 * surface. `#low` and `#high` move the confidence the UI renders.
 *
 *   "Headphones #want"            → contests a `need` tag at 0.85, loudly enough to be said
 *   "Headphones #want #low"       → the same contest at 0.25, which Bucket keeps to itself
 *   "Groceries #need #high"       → agrees with a `need` tag at 0.95
 *
 * The forced confidence clears the floors in `restraint.ts` on purpose, so a marked purchase
 * reaches the surface it was typed to design. `#low` is the one that does not, which makes it
 * the way to walk the withheld path without an API key.
 *
 * Markers are read from the prompt text, so they must appear in the label or note the user
 * actually typed. They are a development affordance, not a feature: nothing else in the app
 * knows about them, and they do nothing once a real adapter is configured.
 */
export const STUB_MARKERS = {
  /** Force the stub to answer "want". */
  want: "#want",
  /** Force the stub to answer "need". */
  need: "#need",
  /** With a forced verdict, report low confidence. */
  low: "#low",
  /** With a forced verdict, report high confidence. */
  high: "#high",
  /** In an explanation: the stub accepts it and agrees with the user's original tag. */
  accept: "#accept",
} as const;

const ACCEPT_EXPLANATION = /#accept\b/i;
const FORCED_VERDICT = /#(want|need)\b/i;
const LOW_CONFIDENCE = /#low\b/i;
const HIGH_CONFIDENCE = /#high\b/i;

const forcedReasoning = (verdict: Intent, marker: string): string =>
  `STUB SCENARIO — no model was consulted. The "${marker}" marker in this purchase forced the ` +
  `answer "${verdict}" so the retraction and clarification surfaces can be designed without an ` +
  `API key. Remove the marker for the stub's default behaviour.`;

/**
 * Stands in for a provider when no credentials are configured.
 *
 * It returns JSON through the same path a real model would, so prompt construction and
 * {@link parseVerdict} are exercised from the start and swapping in a real adapter is a swap
 * rather than a rewrite.
 *
 * By default it agrees and reports zero confidence, which is deliberate. A stub that produced
 * plausible-looking disagreement on its own would be indistinguishable from a working model in
 * the UI, and someone would eventually demo it by accident.
 *
 * {@link STUB_MARKERS} is the narrow exception, and it preserves that property three ways: a
 * disagreement only ever appears when someone explicitly typed a marker, the marker stays
 * visible in the purchase label on screen, and the reasoning text says STUB SCENARIO and names
 * the marker that caused it.
 *
 * Nothing escalates off a forced disagreement either: `judgeTransaction` short-circuits when the
 * screening tier is `stub`, so Ultra is never reached and no spend is possible.
 */
export function createStubAdapter(): ModelAdapter {
  return {
    name: "stub",
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const userMessage = request.messages.find((m) => m.role === "user")?.content ?? "";

      // Recover the user's own tag from the prompt so the stub can agree with it by default.
      const tagged = userMessage.match(/They labelled it: (want|need)/);
      const intent: Intent = (tagged?.[1] as Intent) ?? "want";

      // On a reconsideration, `#accept` in the explanation wins. Without it a marked purchase
      // would hold its verdict forever and the accepted branch could never be designed.
      if (ACCEPT_EXPLANATION.test(userMessage)) {
        return {
          text: JSON.stringify({
            verdict: intent,
            confidence: 0.7,
            reasoning:
              `STUB SCENARIO — no model was consulted. The "#accept" marker in this explanation ` +
              `forced Bucket to accept it, so the accepted branch can be designed without an API key.`,
          }),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }

      const forced = userMessage.match(FORCED_VERDICT);
      if (forced) {
        const verdict = forced[1].toLowerCase() as Intent;
        const confidence = LOW_CONFIDENCE.test(userMessage)
          ? 0.25
          : HIGH_CONFIDENCE.test(userMessage)
            ? 0.95
            : 0.85;

        return {
          text: JSON.stringify({
            verdict,
            confidence,
            reasoning: forcedReasoning(verdict, forced[0]),
            // A forced disagreement carries a question too, so the clarification exchange can
            // be walked end to end without credentials.
            question:
              "What makes this one different from the last time you bought something like it?",
          }),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }

      return {
        text: JSON.stringify({
          verdict: intent,
          confidence: 0,
          reasoning: STUB_REASONING,
        }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
}
