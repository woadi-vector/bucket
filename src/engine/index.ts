/**
 * The verdict engine — Bucket's decision layer.
 *
 * This module is standalone on purpose (plan section 4b). Bucket's UI is one consumer of
 * it, not the only place it can live, so:
 *
 *   - it imports nothing from `src/components/`, `src/routes/`, or React;
 *   - it never reads storage — history is passed in;
 *   - model selection, prompting, tiering and parsing all happen in here;
 *   - the provider sits behind a {@link ModelAdapter} so it can be swapped.
 *
 * `judgeTransaction` is the single entry point and its signature does not change when the
 * stub is replaced by a real model call.
 */

import type { ModelAdapter } from "./adapter";
import { buildVerdictPrompt } from "./prompt";
import { parseVerdict, VerdictParseError } from "./parse";
import { createStubAdapter } from "./stub-adapter";
import type { ModelTier, Verdict, VerdictRequest, VerdictTelemetry } from "./types";

export type { ModelAdapter, ChatMessage, CompletionRequest, CompletionResponse } from "./adapter";
export type {
  Intent,
  ReadinessTag,
  PurchaseUnderReview,
  HistoricalPurchase,
  VerdictRequest,
  Verdict,
  VerdictTelemetry,
  ModelTier,
  TokenUsage,
} from "./types";
export { VerdictParseError } from "./parse";
export { createStubAdapter } from "./stub-adapter";
export {
  createTokenFactoryAdapter,
  TokenFactoryError,
  TOKEN_FACTORY_BASE_URL,
  type TokenFactoryOptions,
} from "./token-factory-adapter";
export { buildVerdictPrompt } from "./prompt";
export { parseVerdict } from "./parse";

/**
 * Model ids per tier.
 *
 * Verified against `GET /v1/models` on 2026-09-20 — see docs/token-factory-findings.md.
 * The plan's provisional ids were wrong twice over: everything is namespaced `nvidia/`,
 * and there is no `Llama-3_1-Nemotron-Ultra-253B-v1` on the platform at all. The actual
 * top Nemotron is a 550B MoE, not 253B.
 */
export const MODELS: Record<Exclude<ModelTier, "stub">, string> = {
  nano: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  ultra: "nvidia/Nemotron-3-Ultra-550b-a55b",
};

export type UsageEvent = {
  telemetry: VerdictTelemetry;
  agrees: boolean;
};

export type EngineOptions = {
  /**
   * Transport. Defaults to the stub.
   *
   * Callers supply an adapter (which carries the provider's credentials); they do not
   * choose the model. Tier selection stays inside the engine.
   */
  adapter?: ModelAdapter;
  /**
   * Asked only when the cheap tier contests the user's tag, to decide whether the
   * expensive one may weigh in.
   *
   * It is a callback rather than a boolean because the answer depends on a spend ledger
   * the engine deliberately cannot see. The engine owns *when* escalation is warranted;
   * the caller owns whether it can be afforded. Omitted means never escalate.
   */
  canEscalate?: () => boolean | Promise<boolean>;
  /**
   * Called once per model call, including the cheap screening pass that preceded an
   * escalation. This is how the split and the per-tier token cost get logged without the
   * engine knowing anything about storage.
   */
  onUsage?: (event: UsageEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /** Injectable clock, so history phrasing is deterministic under test. */
  now?: number;
};

const MAX_TOKENS = 4096;

/**
 * Judges whether the user's own want/need label holds up.
 *
 * Never throws: a provider outage or an unparseable answer degrades to agreeing with the
 * user rather than failing. The engine advises, so silence means "no argument to make",
 * and the caller can tell the difference through `telemetry.degraded`.
 */
export async function judgeTransaction(
  request: VerdictRequest,
  options: EngineOptions = {},
): Promise<Verdict> {
  const adapter = options.adapter ?? createStubAdapter();
  const screeningTier: ModelTier = adapter.name === "stub" ? "stub" : "nano";

  const screening = await runTier(request, options, adapter, screeningTier);
  await options.onUsage?.({ telemetry: screening.telemetry!, agrees: screening.agrees });

  // The cheap pass agreed with the user, so there is no argument to adjudicate and the
  // expensive tier is never touched. This is the whole efficiency claim.
  if (screening.agrees || screening.telemetry?.degraded || screeningTier === "stub") {
    return screening;
  }

  if (!options.canEscalate || !(await options.canEscalate())) {
    return screening;
  }

  /**
   * Adjudication.
   *
   * Ultra is asked the *same* question, not "a smaller model disagreed, what do you
   * think?". Telling it the cheap tier already objected invites it to agree out of
   * deference, and it would make scoring the two tiers against the evaluation set
   * meaningless because they would no longer be answering the same question.
   */
  const adjudication = await runTier(request, options, adapter, "ultra");
  await options.onUsage?.({ telemetry: adjudication.telemetry!, agrees: adjudication.agrees });

  if (adjudication.telemetry?.degraded) return screening;

  return {
    ...adjudication,
    telemetry: { ...adjudication.telemetry!, escalatedFrom: screeningTier },
  };
}

/** One model call, parsed. Degrades rather than throwing. */
async function runTier(
  request: VerdictRequest,
  options: EngineOptions,
  adapter: ModelAdapter,
  tier: ModelTier,
): Promise<Verdict> {
  const model = tier === "stub" ? "stub" : MODELS[tier];
  const startedAt = Date.now();

  try {
    const response = await adapter.complete({
      model,
      messages: buildVerdictPrompt(request, options.now),
      // Reasoning models spend the budget on the trace before emitting an answer. A tight
      // budget returns HTTP 200 with empty content — measured, see the findings doc.
      maxTokens: MAX_TOKENS,
      temperature: 0.2,
      responseFormat: "json_object",
      signal: options.signal,
    });

    const parsed = parseVerdict(response.text, request.purchase.intent);

    return {
      ...parsed,
      telemetry: {
        tier,
        model,
        adapter: adapter.name,
        latencyMs: Date.now() - startedAt,
        usage: response.usage,
      },
    };
  } catch (error) {
    if (!(error instanceof VerdictParseError)) {
      console.error(`[engine] ${tier} verdict request failed`, error);
    }
    return degradedVerdict(request, adapter.name, tier, model, Date.now() - startedAt);
  }
}

/** What the engine says when it has nothing trustworthy to say: it defers to the user. */
function degradedVerdict(
  request: VerdictRequest,
  adapterName: string,
  tier: ModelTier,
  model: string,
  latencyMs: number,
): Verdict {
  return {
    agrees: true,
    verdict: request.purchase.intent,
    confidence: 0,
    reasoning: "",
    telemetry: { tier, model, adapter: adapterName, latencyMs, degraded: true },
  };
}
