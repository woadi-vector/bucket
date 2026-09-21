import { createServerFn } from "@tanstack/react-start";
import { createTokenFactoryAdapter, judgeTransaction } from "@/engine";
import type { Verdict, VerdictRequest } from "@/engine";
import { getSecret } from "@/lib/server-env";

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

    return judgeTransaction(data, { adapter: createTokenFactoryAdapter({ apiKey }) });
  });
