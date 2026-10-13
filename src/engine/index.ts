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
import { buildReconsiderPrompt, buildVerdictPrompt } from "./prompt";
import { parseVerdict, VerdictParseError } from "./parse";
import { createStubAdapter } from "./stub-adapter";
import type {
  CeilingStatus,
  ModelTier,
  ReconsiderRequest,
  Verdict,
  VerdictRequest,
  VerdictTelemetry,
} from "./types";

export type { ModelAdapter, ChatMessage, CompletionRequest, CompletionResponse } from "./adapter";
export type {
  Intent,
  ReadinessTag,
  PurchaseUnderReview,
  HistoricalPurchase,
  VerdictRequest,
  ReconsiderRequest,
  Verdict,
  VerdictTelemetry,
  ModelTier,
  TokenUsage,
  CeilingStatus,
} from "./types";
export { VerdictParseError } from "./parse";
export { createStubAdapter, STUB_MARKERS } from "./stub-adapter";
export {
  createTokenFactoryAdapter,
  TokenFactoryError,
  TOKEN_FACTORY_BASE_URL,
  type TokenFactoryOptions,
} from "./token-factory-adapter";
export { buildVerdictPrompt, buildReconsiderPrompt } from "./prompt";
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
  /**
   * Asked before *every* Token Factory call — the screening pass and any escalation.
   *
   * The global spend ceiling lives in a ledger the engine deliberately cannot see, so the
   * caller answers. When it reports the ceiling reached before screening, the engine makes
   * no call at all and returns a cached verdict. When it trips between screening and
   * escalation, the engine keeps the real screening verdict it already paid for and skips
   * the expensive tier. Omitted means no ceiling.
   */
  checkCeiling?: () => CeilingStatus | Promise<CeilingStatus>;
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

  // The stub costs nothing, so the ceiling only guards real providers.
  if (screeningTier !== "stub" && (await ceilingReached(options))) {
    return cachedVerdict(request, adapter.name);
  }

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

  // The screening call just added to the ledger, so ask again before the expensive tier.
  if (await ceilingReached(options)) {
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
    telemetry: { ...adjudication.telemetry!, escalatedFrom: screeningTier, stage: "adjudication" },
  };
}

/**
 * The second half of the exchange: the person answered the question, and this decides whether
 * the answer holds.
 *
 * Reached only after {@link judgeTransaction} contested a tag and returned a `question`, so it
 * is never the first thing a purchase meets. The expensive tier answers, because weighing a
 * human explanation against a person's own history is the hardest judgement the system makes
 * and the clearest case for it. Whether that is worth its cost is a question for the
 * evaluation set, not an assumption to keep forever.
 *
 * Never throws, for the same reason `judgeTransaction` does not: a provider outage must not
 * punish someone for having explained themselves. A degraded reconsideration accepts the
 * explanation, because Bucket advises, and silence is not an argument.
 */
export async function reconsiderTransaction(
  request: ReconsiderRequest,
  options: EngineOptions = {},
): Promise<Verdict> {
  const adapter = options.adapter ?? createStubAdapter();
  const tier: ModelTier = adapter.name === "stub" ? "stub" : "ultra";

  if (tier !== "stub" && (await ceilingReached(options))) {
    return acceptedByDefault(request, adapter.name, CACHED_REASONING, true);
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await adapter.complete({
      model: tier === "stub" ? "stub" : MODELS.ultra,
      messages: buildReconsiderPrompt(request, options.now),
      maxTokens: MAX_TOKENS,
      signal: options.signal,
    });
  } catch (error) {
    console.error("[engine] reconsideration failed; accepting the explanation", error);
    return acceptedByDefault(request, adapter.name, DEGRADED_RECONSIDER_REASONING, false);
  }

  let parsed;
  try {
    parsed = parseVerdict(response.text, request.purchase.intent);
  } catch (error) {
    if (error instanceof VerdictParseError) {
      console.error("[engine] reconsideration was unparseable; accepting the explanation");
      return acceptedByDefault(request, adapter.name, DEGRADED_RECONSIDER_REASONING, false);
    }
    throw error;
  }

  const verdict: Verdict = {
    ...parsed,
    // Derived, not reported. The model is never asked whether it changed its mind.
    explanationAccepted: parsed.agrees,
    telemetry: {
      tier,
      model: tier === "stub" ? "stub" : MODELS.ultra,
      adapter: adapter.name,
      latencyMs: Date.now() - startedAt,
      usage: response.usage,
      stage: "reconsideration",
    },
  };

  await options.onUsage?.({ telemetry: verdict.telemetry!, agrees: verdict.agrees });
  return verdict;
}

export const DEGRADED_RECONSIDER_REASONING =
  "Bucket could not re-read this one, so your explanation stands.";

/**
 * What a reconsideration returns when no model could answer it.
 *
 * It accepts. The person took the trouble to explain, and holding a verdict against them on
 * the strength of an outage would be the system enforcing rather than advising.
 */
function acceptedByDefault(
  request: ReconsiderRequest,
  adapterName: string,
  reasoning: string,
  cached: boolean,
): Verdict {
  return {
    agrees: true,
    verdict: request.purchase.intent,
    confidence: 0,
    reasoning,
    explanationAccepted: true,
    ...(cached ? { cached: true } : {}),
    telemetry: {
      tier: "stub",
      model: "none",
      adapter: adapterName,
      latencyMs: 0,
      stage: "reconsideration",
      degraded: !cached,
      ...(cached ? { cached: true } : {}),
    },
  };
}

/**
 * Fails closed: if the caller's ceiling check itself throws, the engine treats the ceiling as
 * reached and spends nothing. The cached path keeps the app usable, so an unanswerable
 * "may I spend?" costs the person nothing and cannot turn into unmetered calls.
 */
async function ceilingReached(options: EngineOptions): Promise<boolean> {
  if (!options.checkCeiling) return false;
  try {
    return (await options.checkCeiling()).reached;
  } catch (error) {
    console.error(
      "[engine] ceiling check threw; failing closed and serving a cached verdict",
      error,
    );
    return true;
  }
}

export const CACHED_REASONING =
  "Cached response: Bucket's shared model budget for this demo is used up, so no model was consulted. Your own call stands.";

/**
 * The canned answer served once the global spend ceiling is reached.
 *
 * It agrees with the user, deliberately. No model looked at this purchase, so Bucket has no
 * argument to make, and the product rule is that it advises rather than enforces. Agreeing
 * also means the app stays fully usable: purchases log, the tray works, and no retraction is
 * ever raised off the back of a verdict nobody actually reasoned about.
 */
function cachedVerdict(request: VerdictRequest, adapterName: string): Verdict {
  return {
    agrees: true,
    verdict: request.purchase.intent,
    confidence: 0,
    reasoning: CACHED_REASONING,
    cached: true,
    telemetry: {
      tier: "stub",
      model: "none",
      adapter: adapterName,
      latencyMs: 0,
      cached: true,
    },
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
        stage: "screening",
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
