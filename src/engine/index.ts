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
import type { ModelTier, Verdict, VerdictRequest } from "./types";

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

export type EngineOptions = {
  /**
   * Transport. Defaults to the stub.
   *
   * Callers supply an adapter (which carries the provider's credentials); they do not
   * choose the model. Tier selection stays inside the engine.
   */
  adapter?: ModelAdapter;
  /** Escalate to the expensive tier when the cheap one contests the user's tag. */
  allowEscalation?: boolean;
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
  const tier: ModelTier = adapter.name === "stub" ? "stub" : "nano";
  const model = tier === "stub" ? "stub" : MODELS.nano;
  const startedAt = Date.now();

  try {
    const response = await adapter.complete({
      model,
      messages: buildVerdictPrompt(request, options.now),
      // Reasoning models spend the budget on the trace before emitting an answer, so this
      // is generous on purpose. Phase 3 should tune it against real usage numbers.
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
      console.error("[engine] verdict request failed", error);
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
