/**
 * The verdict engine's vocabulary.
 *
 * These types are deliberately re-declared here rather than imported from
 * `src/lib/bucket-store.ts`. That module pulls in `lucide-react` for bucket icons, so
 * importing it would drag React into the engine and break the boundary in section 4b of
 * the plan. The engine speaks in plain data about money, not in the app's UI types.
 */

export type Intent = "want" | "need";

export type ReadinessTag = "impulse" | "saw_today" | "over_a_week" | "replacing";

/** The purchase being judged, including the call the user made about it. */
export type PurchaseUnderReview = {
  amount: number;
  label: string;
  /** The user's own tag. This is the claim the engine is challenging. */
  intent: Intent;
  readinessTag: ReadinessTag | null;
  /** Human-readable bucket name, e.g. "Dining Out". Never an app id. */
  bucketName?: string;
  /** Anything extra the user offered about why they are buying it. */
  note?: string;
};

/** One prior purchase. The engine never reads these from storage; callers pass them in. */
export type HistoricalPurchase = {
  amount: number;
  label: string;
  intent: Intent;
  readinessTag: ReadinessTag | null;
  timestamp: number;
  bucketName?: string;
};

export type VerdictRequest = {
  purchase: PurchaseUnderReview;
  /** A slice of this user's history. Ordering is not assumed; the engine sorts. */
  history: HistoricalPurchase[];
};

export type ModelTier = "nano" | "ultra" | "stub";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Observability, not control.
 *
 * Phase 3 requires that nothing outside the engine *chooses* a model, and Phase 4 requires
 * logging which model answered and what it cost. Both hold: callers cannot select a tier,
 * and the engine reports after the fact what it used. Callers must not branch on this.
 */
export type VerdictTelemetry = {
  tier: ModelTier;
  model: string;
  adapter: string;
  latencyMs: number;
  usage?: TokenUsage;
  /** True when the verdict came from a fallback rather than a model answer. */
  degraded?: boolean;
};

/**
 * The engine's output. The first four fields are the contract named in the plan and must
 * not change shape when the stub is replaced by a real model call in Phase 3.
 */
export type Verdict = {
  /** Whether the engine agrees with the user's own tag. Derived, never taken on trust. */
  agrees: boolean;
  verdict: Intent;
  /** 0..1. */
  confidence: number;
  reasoning: string;
  telemetry?: VerdictTelemetry;
};
