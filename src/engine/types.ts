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
  /**
   * Facts about the purchase that did not come from the person: where it was bought, what the
   * store catalog calls it. Shown to the model as context, never as something the person said.
   */
  context?: string;
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

/**
 * A contested purchase, sent back with what the person said in their defence.
 *
 * Bucket asks before it reclassifies. The person is the only party who knows why they are
 * buying something, and a system that overrules without asking is both ruder and more often
 * wrong. This is the second half of that exchange.
 */
export type ReconsiderRequest = VerdictRequest & {
  /** The question Bucket asked. Carried so the model can see what was actually asked. */
  question: string;
  /** What the person said back, verbatim. */
  explanation: string;
  /** The verdict being reconsidered — the one the explanation is answering. */
  priorVerdict: Intent;
};

export type ModelTier = "nano" | "ultra" | "stub";

/**
 * What a lookup contributed, recorded after the fact.
 *
 * Kept in telemetry rather than on the verdict itself because the person using the app should
 * hear the finding in the reasoning, in plain words, not read a list of search hits. This is
 * for the ledger and the exchange log, where someone checking the work can see what Bucket was
 * told before it decided.
 */
export type EvidenceTelemetry = {
  provider: string;
  query: string;
  /** How many results were put in front of the model. Zero when only a summary came back. */
  resultCount: number;
  latencyMs: number;
  /**
   * The cheaper option the app priced, when it found one it was willing to stand behind.
   *
   * Recorded because this is the one number the app states about someone else's money, and a
   * claim like that is only worth making if the page it came from can be opened afterwards.
   * Absent means no comparison was made, and in that case no figure was shown either.
   */
  foundPrice?: number;
  savingVsPurchase?: number;
  foundAt?: string;
};

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
  /** Set on an adjudication: the tier whose disagreement triggered the escalation. */
  escalatedFrom?: ModelTier;
  /** Which pass produced this verdict. Screening unless stated. */
  stage?: "screening" | "adjudication" | "reconsideration";
  /**
   * What was looked up before this verdict, when anything was.
   *
   * Absent means no search happened, or it found nothing, or it failed. Those are the same
   * outcome for the verdict and are deliberately not distinguished here: a reader should not
   * be able to mistake "the provider timed out" for a finding.
   */
  evidence?: EvidenceTelemetry;
  /** True when no model was called because the global spend ceiling had been reached. */
  cached?: boolean;
};

/**
 * The caller's answer to "may the engine spend money right now?".
 *
 * The engine cannot read the spend ledger itself — it never touches storage — so the
 * caller supplies this. `reason` is for logs, never for the person using the app.
 */
export type CeilingStatus = { reached: false } | { reached: true; reason: string };

/**
 * Why Bucket held a disagreement back rather than saying it out loud.
 *
 * Its presence on a {@link Verdict} means the person was never shown the argument. Its
 * absence means Bucket spoke. See `restraint.ts` for which silences are earned and why the
 * two reasons are not equally strong.
 */
export type Withheld = {
  reason: "overruled" | "unsure";
  /** The verdict Bucket did not say out loud. */
  verdict: Intent;
  /** The confidence behind that unspoken verdict, as the model reported it. */
  confidence: number;
  /**
   * The argument itself, kept so the log holds the case that was dropped rather than only
   * the fact that one was. A silence nobody can read is not evidence of restraint.
   */
  reasoning: string;
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
  /**
   * True when this is a canned answer served because the global spend ceiling was reached.
   * A cached verdict always agrees with the user: with no model consulted, Bucket has no
   * argument to make, so it must never be mistaken for one.
   */
  cached?: boolean;
  /**
   * What Bucket wants to ask before it reclassifies anything.
   *
   * Present only when the engine contests the user's tag and has a question worth asking.
   * It is an invitation, never a gate: the person can ignore it and the verdict stands as
   * advice either way.
   */
  question?: string;
  /**
   * Set only on a reconsideration: whether the explanation changed the engine's mind.
   *
   * Derived from the new verdict rather than reported by the model, for the same reason
   * `agrees` is. A model asked to restate a judgement it already made will sometimes
   * contradict itself, and this one decides what the person sees.
   */
  explanationAccepted?: boolean;
  /**
   * Set when Bucket disagreed and decided not to say so.
   *
   * Deliberately separate from `agrees`, which keeps reporting the disagreement honestly.
   * Collapsing the two would make a withheld contest indistinguishable from an agreement,
   * and the whole point of recording this is that the silences can be counted.
   */
  withheld?: Withheld;
  telemetry?: VerdictTelemetry;
};
