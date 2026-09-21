import type { CompletionRequest, CompletionResponse, ModelAdapter } from "./adapter";

export const STUB_REASONING =
  "Stub verdict — no model has been consulted. Phase 3 replaces this with a real Token Factory call.";

/**
 * Stands in for a provider until Phase 3.
 *
 * It returns JSON through the same path a real model would, so prompt construction and
 * {@link parseVerdict} are exercised from the start and Phase 3 is a swap rather than a
 * rewrite.
 *
 * It deliberately always agrees and reports zero confidence. A stub that produced
 * plausible-looking disagreement would be indistinguishable from a working model in the UI,
 * and someone would eventually demo it by accident.
 */
export function createStubAdapter(): ModelAdapter {
  return {
    name: "stub",
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      // Recover the user's own tag from the prompt so the stub can agree with it.
      const userMessage = request.messages.find((m) => m.role === "user")?.content ?? "";
      const match = userMessage.match(/They labelled it: (want|need)/);
      const intent = match?.[1] ?? "want";

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
