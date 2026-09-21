import type { CeilingStatus, ModelTier, VerdictTelemetry } from "@/engine";
import { getDb, getEnvVar } from "@/lib/server-env";

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

/**
 * Per-session limits. The global ceiling is separate and configurable — see
 * {@link getGlobalLimits}.
 */
export const BUDGET = {
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
  /** Screening calls — one per verdict, whether or not it escalated. */
  verdicts: number;
  totalTokens: number;
  perSession: Map<string, { calls: number; escalations: number }>;
};

function devCounters(): DevCounters {
  const g = globalThis as { __bucketBudget?: DevCounters };
  if (!g.__bucketBudget) {
    g.__bucketBudget = { totalMicros: 0, verdicts: 0, totalTokens: 0, perSession: new Map() };
  }
  return g.__bucketBudget;
}

/**
 * Global ceiling defaults, used when the Wrangler vars are unset or unreadable.
 *
 * Sized against the real numbers: a verdict is ~650–950 tokens across both tiers and costs
 * 64–73 µ$ at Nano, ~1600 µ$ when it escalates.
 *
 * Note how the defaults interact: every token is priced at no more than the conservative
 * Ultra rate ($2/M), so 5M tokens can never cost more than $10. With these defaults the token
 * limit therefore trips before the $15 limit can — the USD limit only becomes the binding one
 * if `GLOBAL_TOKEN_LIMIT` is raised. It is still worth having: it is the one limit expressed in
 * the unit the credits are actually denominated in.
 */
export const GLOBAL_LIMIT_DEFAULTS = {
  verdicts: 5_000,
  tokens: 5_000_000,
  usd: 15,
} as const;

export type GlobalLimits = { verdicts: number; tokens: number; usd: number };

/**
 * Reads `GLOBAL_VERDICT_LIMIT`, `GLOBAL_TOKEN_LIMIT` and `GLOBAL_USD_LIMIT` from Wrangler `vars`
 * (or `.dev.vars` in development).
 *
 * `0` is honoured and means "never call the model" — a deliberate kill switch. Anything that
 * is not a non-negative number falls back to the default with a warning, rather than being
 * read as 0 and silently switching the model off. Counts are floored; dollars keep their
 * cents, so `GLOBAL_USD_LIMIT=0.50` means fifty cents.
 */
export function getGlobalLimits(): GlobalLimits {
  const read = (name: string, fallback: number, whole: boolean): number => {
    const raw = getEnvVar(name);
    if (raw === undefined) return fallback;
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
      console.warn(`[budget] ${name}="${raw}" is not a non-negative number; using ${fallback}`);
      return fallback;
    }
    return whole ? Math.floor(n) : n;
  };
  return {
    verdicts: read("GLOBAL_VERDICT_LIMIT", GLOBAL_LIMIT_DEFAULTS.verdicts, true),
    tokens: read("GLOBAL_TOKEN_LIMIT", GLOBAL_LIMIT_DEFAULTS.tokens, true),
    usd: read("GLOBAL_USD_LIMIT", GLOBAL_LIMIT_DEFAULTS.usd, false),
  };
}

type GlobalUsage = { verdicts: number; tokens: number; costMicros: number };

/**
 * Every session's usage combined. Verdicts count screening calls; tokens and cost count every
 * tier. Cost is the ledger's own estimate (see {@link PRICE_USD_PER_MTOK}), not Nebius billing.
 */
async function readGlobalUsage(): Promise<GlobalUsage> {
  const db = getDb();
  if (!db) {
    const c = devCounters();
    return { verdicts: c.verdicts, tokens: c.totalTokens, costMicros: c.totalMicros };
  }
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN tier = 'nano' THEN 1 ELSE 0 END), 0) AS verdicts,
              COALESCE(SUM(total_tokens), 0)                          AS tokens,
              COALESCE(SUM(cost_micros), 0)                           AS costMicros
         FROM model_usage`,
    )
    .first<{ verdicts: number; tokens: number; costMicros: number }>();
  if (!row) throw new Error("model_usage aggregate returned no row");
  return { verdicts: row.verdicts, tokens: row.tokens, costMicros: row.costMicros };
}

const formatUsd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/**
 * The global spend ceiling, across all sessions.
 *
 * Handed to the engine as its `checkCeiling` hook and asked before every Token Factory call.
 * Trips when *any* of the three limits is reached, and logs each time it holds a call back,
 * with the totals that tripped it.
 *
 * Fails **closed**. If the ledger cannot be read, the ceiling reports itself reached and the
 * engine serves a cached verdict rather than calling the model. That costs the demo nothing —
 * the cached path already keeps the app fully usable — and it means a broken ledger can never
 * turn into unmetered spend. It logs distinctly from a normal trip, because "the budget is used
 * up" and "we cannot tell how much budget is left" call for different responses.
 *
 * This is deliberately the opposite of the per-session guard, which still fails open: that one
 * rations a single visitor, while this one is the last thing standing between a login-free URL
 * and the credits.
 */
export async function checkGlobalCeiling(): Promise<CeilingStatus> {
  const limits = getGlobalLimits();

  let usage: GlobalUsage;
  try {
    usage = await readGlobalUsage();
  } catch (error) {
    console.error(
      "[budget] GLOBAL CEILING FAIL-CLOSED — ledger unreadable, serving cached verdict instead of calling the model",
      error,
    );
    return { reached: true, reason: "ledger unreadable (fail-closed)" };
  }

  const spentUsd = usage.costMicros / USD_TO_MICROS;
  const overVerdicts = usage.verdicts >= limits.verdicts;
  const overTokens = usage.tokens >= limits.tokens;
  const overUsd = spentUsd >= limits.usd;
  if (!overVerdicts && !overTokens && !overUsd) return { reached: false };

  const reason = [
    overVerdicts ? `verdicts ${usage.verdicts}/${limits.verdicts}` : null,
    overTokens ? `tokens ${usage.tokens}/${limits.tokens}` : null,
    overUsd ? `usd ${formatUsd(spentUsd)}/${formatUsd(limits.usd)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.warn(`[budget] GLOBAL CEILING TRIPPED — serving cached verdict (${reason})`);
  return { reached: true, reason };
}

/**
 * Per-session limits: whether this visitor may make one more paid call.
 *
 * The global ceiling is enforced separately, by {@link checkGlobalCeiling}. Fails **open** on
 * a storage error — a broken ledger should not take the demo offline.
 */
export async function checkBudget(sessionId: string, tier: ModelTier): Promise<BudgetDecision> {
  if (tier === "stub") return { allowed: true };

  const db = getDb();

  if (!db) {
    const c = devCounters();
    const s = c.perSession.get(sessionId) ?? { calls: 0, escalations: 0 };
    if (s.calls >= BUDGET.sessionVerdicts) {
      return { allowed: false, reason: "session verdict limit reached" };
    }
    if (tier === "ultra" && s.escalations >= BUDGET.sessionEscalations) {
      return { allowed: false, reason: "session escalation limit reached" };
    }
    return { allowed: true };
  }

  try {
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
    console.error(
      "[budget] per-session ledger read failed; session limits not enforced for this call (the global ceiling still applies)",
      error,
    );
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
    c.totalTokens += totalTokens;
    if (telemetry.tier === "nano") c.verdicts += 1;
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
