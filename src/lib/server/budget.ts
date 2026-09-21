import type { ModelTier, VerdictTelemetry } from "@/engine";
import { getDb } from "@/lib/server-env";

/**
 * Spend accounting and the budget guard.
 *
 * The demo URL has no login by design, so anyone can trigger paid inference. The account
 * holds roughly $25. At measured token counts that is hundreds of thousands of Nano calls,
 * so the budget is not the real risk — a runaway loop or someone hammering the endpoint is.
 * This module exists to make that failure bounded instead of open-ended.
 */

/**
 * Conservative price estimates, in US dollars per million tokens.
 *
 * Token Factory does not expose pricing through the API and Nebius does not publish
 * per-token rates publicly. Third-party blended figures put Nano around $0.02–0.08/M and
 * Ultra around $1.16/M. These constants sit deliberately above those numbers: if the real
 * price is lower we stop spending earlier than necessary, which is the safe direction to be
 * wrong in. Revise when official pricing is available.
 */
export const PRICE_USD_PER_MTOK: Record<ModelTier, number> = {
  nano: 0.1,
  ultra: 2.0,
  stub: 0,
};

export const BUDGET = {
  /** Hard ceiling on all spend, ever. Well under the ~$25 available. */
  totalUsd: 10,
  /** Verdicts one session may request. A judge exploring uses 10–20. */
  sessionVerdicts: 60,
  /** Escalations to the expensive tier one session may trigger. */
  sessionEscalations: 10,
} as const;

const USD_TO_MICROS = 1_000_000;

export function estimateCostMicros(tier: ModelTier, totalTokens: number): number {
  const usd = (totalTokens / 1_000_000) * PRICE_USD_PER_MTOK[tier];
  return Math.ceil(usd * USD_TO_MICROS);
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * In-memory counters for development, where there is no D1 binding.
 *
 * Held on globalThis so they survive Vite module reloads. These are per-process and reset
 * on restart, which is fine: in development the point is to catch a runaway loop, not to
 * account for money.
 */
type DevCounters = {
  totalMicros: number;
  perSession: Map<string, { calls: number; escalations: number }>;
};

function devCounters(): DevCounters {
  const g = globalThis as { __bucketBudget?: DevCounters };
  if (!g.__bucketBudget) g.__bucketBudget = { totalMicros: 0, perSession: new Map() };
  return g.__bucketBudget;
}

/**
 * Decides whether one more paid call is allowed.
 *
 * Fails **open** on a storage error. A broken ledger should not take the demo offline —
 * the global ceiling is the backstop, and the amounts at stake are small.
 */
export async function checkBudget(sessionId: string, tier: ModelTier): Promise<BudgetDecision> {
  if (tier === "stub") return { allowed: true };

  const db = getDb();

  if (!db) {
    const c = devCounters();
    const s = c.perSession.get(sessionId) ?? { calls: 0, escalations: 0 };
    if (c.totalMicros >= BUDGET.totalUsd * USD_TO_MICROS) {
      return { allowed: false, reason: "global budget reached" };
    }
    if (s.calls >= BUDGET.sessionVerdicts) {
      return { allowed: false, reason: "session verdict limit reached" };
    }
    if (tier === "ultra" && s.escalations >= BUDGET.sessionEscalations) {
      return { allowed: false, reason: "session escalation limit reached" };
    }
    return { allowed: true };
  }

  try {
    const totals = await db
      .prepare("SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM model_usage")
      .first<{ spent: number }>();
    if ((totals?.spent ?? 0) >= BUDGET.totalUsd * USD_TO_MICROS) {
      return { allowed: false, reason: "global budget reached" };
    }

    const session = await db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN tier = 'ultra' THEN 1 ELSE 0 END), 0) AS escalations
           FROM model_usage
          WHERE session_id = ?`,
      )
      .bind(sessionId)
      .first<{ calls: number; escalations: number }>();

    if ((session?.calls ?? 0) >= BUDGET.sessionVerdicts) {
      return { allowed: false, reason: "session verdict limit reached" };
    }
    if (tier === "ultra" && (session?.escalations ?? 0) >= BUDGET.sessionEscalations) {
      return { allowed: false, reason: "session escalation limit reached" };
    }
    return { allowed: true };
  } catch (error) {
    console.error("[budget] ledger read failed; allowing the call", error);
    return { allowed: true };
  }
}

/**
 * Writes one call to the ledger. Never throws — losing a usage row must not fail a verdict
 * the user is waiting on.
 */
export async function recordUsage(args: {
  sessionId: string;
  subjectId?: string;
  telemetry: VerdictTelemetry;
  agreed: boolean;
}): Promise<void> {
  const { sessionId, subjectId, telemetry, agreed } = args;
  if (telemetry.tier === "stub") return;

  const usage = telemetry.usage;
  const totalTokens = usage?.totalTokens ?? 0;
  const costMicros = estimateCostMicros(telemetry.tier, totalTokens);

  const db = getDb();
  if (!db) {
    const c = devCounters();
    c.totalMicros += costMicros;
    const s = c.perSession.get(sessionId) ?? { calls: 0, escalations: 0 };
    s.calls += 1;
    if (telemetry.tier === "ultra") s.escalations += 1;
    c.perSession.set(sessionId, s);
    return;
  }

  try {
    await db
      .prepare(
        `INSERT INTO model_usage
           (id, session_id, subject_id, tier, model, prompt_tokens, completion_tokens,
            total_tokens, cost_micros, latency_ms, degraded, agreed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        sessionId,
        subjectId ?? null,
        telemetry.tier,
        telemetry.model,
        usage?.promptTokens ?? 0,
        usage?.completionTokens ?? 0,
        totalTokens,
        costMicros,
        telemetry.latencyMs,
        telemetry.degraded ? 1 : 0,
        agreed ? 1 : 0,
        Date.now(),
      )
      .run();
  } catch (error) {
    console.error("[budget] failed to record usage", error);
  }
}

/** Totals for the demo's efficiency panel. */
export async function readUsageSummary(): Promise<{
  byTier: Array<{ tier: string; calls: number; totalTokens: number; costMicros: number }>;
  totalCostMicros: number;
}> {
  const db = getDb();
  if (!db) return { byTier: [], totalCostMicros: devCounters().totalMicros };

  try {
    const rows = await db
      .prepare(
        `SELECT tier,
                COUNT(*)                  AS calls,
                COALESCE(SUM(total_tokens), 0) AS totalTokens,
                COALESCE(SUM(cost_micros), 0)  AS costMicros
           FROM model_usage
          GROUP BY tier`,
      )
      .all<{ tier: string; calls: number; totalTokens: number; costMicros: number }>();

    const byTier = rows.results ?? [];
    return {
      byTier,
      totalCostMicros: byTier.reduce((sum, r) => sum + r.costMicros, 0),
    };
  } catch (error) {
    console.error("[budget] summary read failed", error);
    return { byTier: [], totalCostMicros: 0 };
  }
}
