import { createServerFn } from "@tanstack/react-start";
import { createTokenFactoryAdapter, judgeTransaction } from "@/engine";
import type { Verdict, VerdictRequest } from "@/engine";
import { getSecret } from "@/lib/server-env";
import { getOrCreateSessionId } from "@/lib/server/session";
import { checkBudget, recordUsage } from "@/lib/server/budget";

/**
 * The server side of the verdict call.
 *
 * Its only jobs are to hold the API key and hand the request to the engine. All reasoning —
 * model selection, prompting, tiering, parsing — lives in `src/engine/` and nothing here
 * knows or chooses which model answers.
 *
 * The key is read server-side only. This module must never be imported from a component.
 */

function requireIntent(v: unknown): "want" | "need" {
  if (v === "want" || v === "need") return v;
  throw new Error("intent must be 'want' or 'need'");
}

/** Client input is untrusted: it reaches a paid API, so validate before spending anything. */
function validateRequest(data: unknown): VerdictRequest {
  if (typeof data !== "object" || data === null) throw new Error("Invalid verdict request");
  const { purchase, history } = data as Record<string, unknown>;

  if (typeof purchase !== "object" || purchase === null) throw new Error("Missing purchase");
  const p = purchase as Record<string, unknown>;
  if (typeof p.amount !== "number" || !Number.isFinite(p.amount)) {
    throw new Error("purchase.amount must be a number");
  }
  if (typeof p.label !== "string") throw new Error("purchase.label must be a string");

  const rawHistory = Array.isArray(history) ? history : [];

  return {
    purchase: {
      amount: p.amount,
      // Cap the strings: they go into a prompt, and an unbounded label is a cost vector.
      label: p.label.slice(0, 200),
      intent: requireIntent(p.intent),
      readinessTag: (p.readinessTag ?? null) as VerdictRequest["purchase"]["readinessTag"],
      bucketName: typeof p.bucketName === "string" ? p.bucketName.slice(0, 80) : undefined,
      note: typeof p.note === "string" ? p.note.slice(0, 500) : undefined,
    },
    history: rawHistory.slice(0, 50).map((h) => {
      const item = h as Record<string, unknown>;
      return {
        amount: typeof item.amount === "number" ? item.amount : 0,
        label: typeof item.label === "string" ? item.label.slice(0, 200) : "",
        intent: requireIntent(item.intent),
        readinessTag: (item.readinessTag ?? null) as VerdictRequest["purchase"]["readinessTag"],
        timestamp: typeof item.timestamp === "number" ? item.timestamp : 0,
        bucketName: typeof item.bucketName === "string" ? item.bucketName.slice(0, 80) : undefined,
      };
    }),
  };
}

export const requestVerdict = createServerFn({ method: "POST" })
  .inputValidator(validateRequest)
  .handler(async ({ data }): Promise<Verdict> => {
    const apiKey = getSecret("NEBIUS_API_KEY");

    // No key configured is not an error the person using the app should see. The engine
    // already degrades to agreeing with them; falling through to the stub does the same.
    if (!apiKey) {
      console.warn("[verdict] NEBIUS_API_KEY is not set — falling back to the stub adapter");
      return judgeTransaction(data);
    }

    const sessionId = getOrCreateSessionId();

    // Nano screens every tagged purchase, and the demo URL has no login, so this is the
    // one place a stranger can spend money. Check before the call, not after.
    const decision = await checkBudget(sessionId, "nano");
    if (!decision.allowed) {
      console.warn(`[verdict] budget guard declined a call: ${decision.reason}`);
      return judgeTransaction(data); // stub — degrades to agreeing with the user
    }

    const verdict = await judgeTransaction(data, {
      adapter: createTokenFactoryAdapter({ apiKey }),

      // The engine decides escalation is *warranted*; we decide it is affordable. It only
      // asks when the cheap tier has contested the user's tag.
      canEscalate: async () => {
        const escalation = await checkBudget(sessionId, "ultra");
        if (!escalation.allowed) {
          console.warn(`[verdict] escalation declined: ${escalation.reason}`);
        }
        return escalation.allowed;
      },

      // Fires once per model call, so an escalated verdict writes two rows and the ledger
      // shows the split rather than only the tier that had the last word.
      onUsage: ({ telemetry, agrees }) => recordUsage({ sessionId, telemetry, agreed: agrees }),
    });

    // Telemetry names the model and its token cost. It stays server-side, in model_usage —
    // the browser gets the four contract fields and no clue which model answered.
    return {
      agrees: verdict.agrees,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
    };
  });
