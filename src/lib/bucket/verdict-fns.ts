import { createServerFn } from "@tanstack/react-start";
import { createTokenFactoryAdapter, judgeTransaction, reconsiderTransaction } from "@/engine";
import type { ReconsiderRequest, Verdict, VerdictRequest, VerdictTelemetry } from "@/engine";
import type { VerdictAttribution } from "@/lib/bucket-store";
import { attributionFor } from "@/lib/attribution";
import { getSecret } from "@/lib/server-env";
import { getOrCreateSessionId } from "@/lib/server/session";
import { checkBudget, checkGlobalCeiling, recordUsage } from "@/lib/server/budget";
import { recordChallenge, recordReconsideration } from "@/lib/server/exchanges";
import { createTavilySource } from "@/lib/server/tavily";

/**
 * What the browser receives.
 *
 * Narrower than the engine's {@link Verdict} on purpose: telemetry names the model and its
 * token cost and stays server-side. Wider in one place — `exchangeId` identifies the stored
 * challenge so an explanation can be attached to it later.
 */
export type VerdictResponse = Pick<
  Verdict,
  "agrees" | "verdict" | "confidence" | "reasoning" | "question" | "explanationAccepted"
> & {
  cached?: true;
  withheld?: true;
  exchangeId?: string;
  attribution?: VerdictAttribution;
};

/**
 * Strips telemetry and drops absent optional fields rather than sending nulls.
 *
 * A withheld contest is the one case where this removes something the engine produced: the
 * browser is told Bucket kept quiet and is not told what it would have said, so no later
 * change to a component can render the argument at someone anyway. The unspoken verdict and
 * the reason for the silence go to the exchange log, where they are counted and not shown.
 *
 * Only a *live* contest is hidden, which is why this reads `agrees` as well. When the
 * expensive tier overrules the cheap one, the verdict that comes back genuinely agrees with
 * the person and its reasoning is an agreement, not a suppressed argument. That case leaves
 * here looking exactly like any other agreement, because as far as the person is concerned
 * it is one. The dropped contest exists only in the log.
 */
function toResponse(
  verdict: Verdict,
  exchangeId?: string,
  attribution?: VerdictAttribution,
): VerdictResponse {
  const hidden = Boolean(verdict.withheld) && !verdict.agrees;

  return {
    // `attributionFor` has already applied the spoken-contest rule, so an overruled or
    // withheld verdict arrives here with nothing to attach.
    ...(attribution ? { attribution } : {}),
    agrees: verdict.agrees,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    reasoning: hidden ? "" : verdict.reasoning,
    ...(verdict.question && !hidden ? { question: verdict.question } : {}),
    ...(hidden ? { withheld: true as const } : {}),
    ...(verdict.explanationAccepted !== undefined
      ? { explanationAccepted: verdict.explanationAccepted }
      : {}),
    // Lets the client — and anyone reading the stored state — tell a canned answer from a
    // model's. Only present when true, so ordinary verdicts are unchanged.
    ...(verdict.cached ? { cached: true } : {}),
    ...(exchangeId ? { exchangeId } : {}),
  };
}

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
  .handler(async ({ data }): Promise<VerdictResponse> => {
    const apiKey = getSecret("NEBIUS_API_KEY");

    // No key configured is not an error the person using the app should see. The engine
    // already degrades to agreeing with them; falling through to the stub does the same.
    if (!apiKey) {
      console.warn("[verdict] NEBIUS_API_KEY is not set — falling back to the stub adapter");
      return logged(await judgeTransaction(data), data);
    }

    const sessionId = getOrCreateSessionId();

    // Nano screens every tagged purchase, and the demo URL has no login, so this is the
    // one place a stranger can spend money. Check before the call, not after.
    const decision = await checkBudget(sessionId, "nano");
    if (!decision.allowed) {
      console.warn(`[verdict] budget guard declined a call: ${decision.reason}`);
      // Stub — degrades to agreeing with the user.
      return logged(await judgeTransaction(data), data, sessionId);
    }

    // Every model call that answers, in the order they happened. The engine returns only the
    // final verdict, so this is where the screening model's identity survives an escalation.
    const calls: VerdictTelemetry[] = [];

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
      onUsage: ({ telemetry, agrees }) => {
        calls.push(telemetry);
        recordUsage({ sessionId, telemetry, agreed: agrees });
      },

      // Across every session. Asked by the engine before each Token Factory call; once it
      // trips, the engine stops calling the model and serves a cached verdict instead.
      checkCeiling: checkGlobalCeiling,
    });

    return logged(verdict, data, sessionId, attributionFor(verdict, calls));
  });

/**
 * Records a contested verdict and hands back the response the browser sees.
 *
 * Only disagreements are stored. An agreement is not an exchange, and counting it would pad
 * the denominator with purchases Bucket never questioned.
 *
 * A withheld contest is stored even though it was never spoken, and an overruled one is
 * stored even though the verdict that comes back agrees with the person. That is the whole
 * reason the log is worth anything: a record of only the disagreements Bucket chose to voice
 * would describe an app that disagrees with everything, and the restraint would be a claim
 * with nothing behind it. The silences are the part that could not have been faked.
 *
 * A failed write costs the reader an `exchangeId` and nothing else: the verdict still goes
 * back, and the reconsideration path writes a standalone row when it arrives without one.
 */
async function logged(
  verdict: Verdict,
  request: VerdictRequest,
  sessionId?: string,
  attribution?: VerdictAttribution,
): Promise<VerdictResponse> {
  if (verdict.agrees && !verdict.withheld) return toResponse(verdict);
  const id = await recordChallenge({
    sessionId: sessionId ?? getOrCreateSessionId(),
    request,
    verdict,
  });

  // The id is how an explanation gets attached to this exact challenge later, so it only
  // belongs in a response that asked the person something. A withheld contest asked nothing
  // and has nothing to attach: sending its id would hand the browser a handle to a row the
  // person was deliberately not shown.
  return toResponse(verdict, verdict.withheld ? undefined : id, attribution);
}

/**
 * Client input for the second pass. Same rules as above: it reaches a paid API, so every
 * field is validated and every string is capped before anything is spent.
 */
function validateReconsiderRequest(data: unknown): ReconsiderRequest & { exchangeId?: string } {
  const base = validateRequest(data);
  const { question, explanation, priorVerdict, exchangeId } = data as Record<string, unknown>;

  if (typeof explanation !== "string" || !explanation.trim()) {
    throw new Error("explanation is required");
  }

  return {
    ...base,
    question: typeof question === "string" ? question.slice(0, 500) : "",
    explanation: explanation.slice(0, 1000),
    priorVerdict: requireIntent(priorVerdict),
    // Which stored challenge this answers. Absent is normal: the write that would have
    // produced it may have failed, and the log handles that by writing a standalone row.
    ...(typeof exchangeId === "string" && exchangeId.trim()
      ? { exchangeId: exchangeId.slice(0, 64) }
      : {}),
  };
}

/**
 * The person answered Bucket's question. This decides whether the answer holds.
 *
 * Reached only after a contested verdict, so it is never a purchase's first encounter with a
 * model. The expensive tier answers, which is why the budget guard is asked for `ultra` here
 * rather than `nano`.
 *
 * Every refusal path accepts the explanation rather than holding a verdict the person has
 * already taken the trouble to answer. A guard that silently hardened into "no" would turn
 * the question into theatre, which is the opposite of the point.
 */
export const requestReconsideration = createServerFn({ method: "POST" })
  .inputValidator(validateReconsiderRequest)
  .handler(async ({ data }): Promise<VerdictResponse> => {
    const apiKey = getSecret("NEBIUS_API_KEY");
    const sessionId = getOrCreateSessionId();

    // Every path below ends at the same two lines: answer, then write it down. The record is
    // only worth reading if it contains the times Bucket was wrong and the times it never
    // really answered, so no branch here gets to skip the log.
    const settle = async (verdict: Verdict): Promise<VerdictResponse> => {
      await recordReconsideration({
        sessionId,
        exchangeId: data.exchangeId,
        request: data,
        verdict,
      });
      return toResponse(verdict);
    };

    if (!apiKey) {
      console.warn("[reconsider] NEBIUS_API_KEY is not set — falling back to the stub adapter");
      return settle(await reconsiderTransaction(data));
    }

    const decision = await checkBudget(sessionId, "ultra");
    if (!decision.allowed) {
      console.warn(`[reconsider] budget guard declined a call: ${decision.reason}`);
      // Stub — accepts the explanation.
      return settle(await reconsiderTransaction(data));
    }

    // A lookup is offered only when a key is configured. Without one the engine reconsiders
    // on the person's explanation and their history alone, exactly as it did before.
    const tavilyKey = getSecret("TAVILY_API_KEY");
    if (!tavilyKey) {
      console.warn("[reconsider] TAVILY_API_KEY is not set — reconsidering without a lookup");
    }

    return settle(
      await reconsiderTransaction(data, {
        adapter: createTokenFactoryAdapter({ apiKey }),
        ...(tavilyKey ? { evidence: createTavilySource({ apiKey: tavilyKey }) } : {}),
        onUsage: ({ telemetry, agrees }) => recordUsage({ sessionId, telemetry, agreed: agrees }),
        checkCeiling: checkGlobalCeiling,
      }),
    );
  });
