import type { Intent, Verdict, VerdictRequest } from "@/engine";
import { getDb, getEnvVar } from "@/lib/server-env";

/**
 * The record of what Bucket asked and what it was told.
 *
 * Every other number in this app is self-reported. This table is the one a judge can read
 * instead of believing us, which only works if it contains the challenges Bucket got wrong
 * as well as the ones it got right. Nothing here filters for flattering rows.
 *
 * Writes never throw. A lost row is worth less than a verdict the person is waiting on.
 */

export type ExchangeRow = {
  id: string;
  amount: number;
  label: string;
  bucketName: string | null;
  readinessTag: string | null;
  userIntent: Intent;
  screeningVerdict: Intent;
  screeningConfidence: number;
  screeningReasoning: string | null;
  question: string | null;
  explanation: string | null;
  finalVerdict: Intent | null;
  finalConfidence: number | null;
  finalReasoning: string | null;
  explanationAccepted: number | null;
  /**
   * Why Bucket kept this disagreement to itself, or null when it said it out loud.
   *
   * `overruled` means the expensive tier sided with the person against the cheap one, in
   * which case the `screening_*` columns hold the contest that was dropped and
   * `overruled_*` holds the answer that beat it. `unsure` means the contest stood but fell
   * under the confidence floor.
   */
  withheldReason: "overruled" | "unsure" | null;
  overruledVerdict: Intent | null;
  overruledReasoning: string | null;
  /** What was looked up before the second pass, when anything was. Null means no lookup. */
  evidenceProvider: string | null;
  evidenceQuery: string | null;
  evidenceResults: number | null;
  degraded: number;
  createdAt: number;
  answeredAt: number | null;
};

/**
 * Development store. `npm run dev` is a plain Node server with no D1 binding, so the same
 * globalThis trick the rest of `src/lib/server` uses keeps rows across Vite reloads.
 */
function devRows(): Map<string, ExchangeRow> {
  const g = globalThis as { __bucketExchanges?: Map<string, ExchangeRow> };
  if (!g.__bucketExchanges) g.__bucketExchanges = new Map();
  return g.__bucketExchanges;
}

/**
 * Records a contested verdict and returns the row's id.
 *
 * Called whenever the screening pass disagreed with the person's tag, whether or not Bucket
 * went on to say so. A plain agreement is still not an exchange and is still not recorded:
 * there was nothing to discuss, and counting it would pad the denominator with cases where
 * Bucket never had an argument in the first place.
 *
 * The overruled rows are the reason this cannot simply key off the returned verdict. When
 * the expensive tier takes the person's side, what comes back agrees with them, and reading
 * only that would throw away the fact that the cheap tier objected first. So the contest is
 * read from `verdict.withheld` when one is present and from the verdict itself otherwise.
 *
 * The id goes back to the browser so that an explanation can be attached to this exact
 * challenge later. It identifies a row, carries no session authority, and grants nothing:
 * the worst a forged one can do is attach an explanation to the wrong exchange.
 */
export async function recordChallenge(args: {
  sessionId: string;
  request: VerdictRequest;
  verdict: Verdict;
}): Promise<string | undefined> {
  const { sessionId, request, verdict } = args;
  const { purchase } = request;

  // The contest as it stood, which is the withheld one when there is one. An `unsure` row
  // reads the same values either way; an `overruled` row would otherwise record the answer
  // that won and lose the objection entirely.
  const contest = verdict.withheld ?? verdict;
  const overruled = verdict.withheld?.reason === "overruled";

  const row: ExchangeRow = {
    id: crypto.randomUUID(),
    amount: purchase.amount,
    label: purchase.label,
    bucketName: purchase.bucketName ?? null,
    readinessTag: purchase.readinessTag ?? null,
    userIntent: purchase.intent,
    screeningVerdict: contest.verdict,
    screeningConfidence: contest.confidence,
    screeningReasoning: contest.reasoning || null,
    withheldReason: verdict.withheld?.reason ?? null,
    // Only an overruled contest has an answer that beat it. Reading the returned verdict
    // here on any other row would record Bucket arguing with itself.
    overruledVerdict: overruled ? verdict.verdict : null,
    overruledReasoning: overruled ? verdict.reasoning || null : null,
    // A withheld contest was never put to the person, so there is no question to answer.
    question: verdict.withheld ? null : (verdict.question ?? null),
    explanation: null,
    finalVerdict: null,
    finalConfidence: null,
    finalReasoning: null,
    explanationAccepted: null,
    // Screening never looks anything up: there is no claim to check until the person speaks.
    evidenceProvider: null,
    evidenceQuery: null,
    evidenceResults: null,
    // A cached or fallback answer is not evidence about the model. Flag it at write time so
    // no later query has to guess which rows to exclude.
    degraded: verdict.cached || verdict.telemetry?.degraded ? 1 : 0,
    createdAt: Date.now(),
    answeredAt: null,
  };

  const db = getDb();
  if (!db) {
    devRows().set(row.id, row);
    return row.id;
  }

  try {
    await db
      .prepare(
        `INSERT INTO exchanges
           (id, session_id, amount, label, bucket_name, readiness_tag, user_intent,
            screening_verdict, screening_confidence, screening_reasoning, question,
            withheld_reason, overruled_verdict, overruled_reasoning,
            degraded, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        sessionId,
        row.amount,
        row.label,
        row.bucketName,
        row.readinessTag,
        row.userIntent,
        row.screeningVerdict,
        row.screeningConfidence,
        row.screeningReasoning,
        row.question,
        row.withheldReason,
        row.overruledVerdict,
        row.overruledReasoning,
        row.degraded,
        row.createdAt,
      )
      .run();
    return row.id;
  } catch (error) {
    console.error("[exchanges] failed to record a challenge", error);
    return undefined;
  }
}

/**
 * Attaches the person's explanation and Bucket's answer to it.
 *
 * `exchangeId` comes from the browser and may be missing, stale, or from another session's
 * row. When the update matches nothing a standalone row is written instead, because losing
 * the reconsideration entirely would quietly bias the record toward challenges that were
 * never argued with.
 */
export async function recordReconsideration(args: {
  sessionId: string;
  exchangeId?: string;
  request: VerdictRequest & { question: string; explanation: string; priorVerdict: Intent };
  verdict: Verdict;
}): Promise<void> {
  const { sessionId, exchangeId, request, verdict } = args;
  const now = Date.now();
  const degraded = verdict.cached || verdict.telemetry?.degraded ? 1 : 0;
  // Absent whenever no lookup contributed, which is the normal case.
  const ev = verdict.telemetry?.evidence;

  const db = getDb();
  if (!db) {
    const rows = devRows();
    const existing = exchangeId ? rows.get(exchangeId) : undefined;
    const target: ExchangeRow = existing ?? {
      id: crypto.randomUUID(),
      amount: request.purchase.amount,
      label: request.purchase.label,
      bucketName: request.purchase.bucketName ?? null,
      readinessTag: request.purchase.readinessTag ?? null,
      userIntent: request.purchase.intent,
      screeningVerdict: request.priorVerdict,
      screeningConfidence: 0,
      screeningReasoning: null,
      question: request.question || null,
      // A reconsideration only exists because the person was asked something, so this
      // reconstructed row is a contest Bucket voiced. Nothing was withheld.
      withheldReason: null,
      overruledVerdict: null,
      overruledReasoning: null,
      explanation: null,
      finalVerdict: null,
      finalConfidence: null,
      finalReasoning: null,
      explanationAccepted: null,
      evidenceProvider: null,
      evidenceQuery: null,
      evidenceResults: null,
      degraded,
      createdAt: now,
      answeredAt: null,
    };
    rows.set(target.id, {
      ...target,
      explanation: request.explanation,
      finalVerdict: verdict.verdict,
      finalConfidence: verdict.confidence,
      finalReasoning: verdict.reasoning || null,
      explanationAccepted: verdict.explanationAccepted ? 1 : 0,
      evidenceProvider: ev?.provider ?? null,
      evidenceQuery: ev?.query ?? null,
      evidenceResults: ev?.resultCount ?? null,
      degraded: target.degraded || degraded,
      answeredAt: now,
    });
    return;
  }

  try {
    if (exchangeId) {
      const result = await db
        .prepare(
          `UPDATE exchanges
              SET explanation = ?, final_verdict = ?, final_confidence = ?, final_reasoning = ?,
                  explanation_accepted = ?, evidence_provider = ?, evidence_query = ?,
                  evidence_results = ?, degraded = MAX(degraded, ?), answered_at = ?
            WHERE id = ? AND session_id = ?`,
        )
        .bind(
          request.explanation,
          verdict.verdict,
          verdict.confidence,
          verdict.reasoning || null,
          verdict.explanationAccepted ? 1 : 0,
          ev?.provider ?? null,
          ev?.query ?? null,
          ev?.resultCount ?? null,
          degraded,
          now,
          exchangeId,
          sessionId,
        )
        .run();
      // D1 reports rows written in `meta.changes`. An explicit zero means the id matched
      // nothing and the explanation would otherwise be lost, so fall through and insert.
      //
      // An absent count is treated as a match, not as zero. Guessing wrong in that direction
      // undercounts answered challenges; guessing the other way invents a second row for an
      // exchange that happened once, and a log that fabricates rows is worth less than a log
      // that misses some.
      const changes = result.meta?.changes;
      if (changes === undefined || changes > 0) return;
      console.warn(`[exchanges] no row matched ${exchangeId}; writing a standalone row`);
    }

    await db
      .prepare(
        `INSERT INTO exchanges
           (id, session_id, amount, label, bucket_name, readiness_tag, user_intent,
            screening_verdict, screening_confidence, screening_reasoning, question,
            explanation, final_verdict, final_confidence, final_reasoning,
            explanation_accepted, evidence_provider, evidence_query, evidence_results,
            degraded, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        sessionId,
        request.purchase.amount,
        request.purchase.label,
        request.purchase.bucketName ?? null,
        request.purchase.readinessTag ?? null,
        request.purchase.intent,
        request.priorVerdict,
        0,
        null,
        request.question || null,
        request.explanation,
        verdict.verdict,
        verdict.confidence,
        verdict.reasoning || null,
        verdict.explanationAccepted ? 1 : 0,
        ev?.provider ?? null,
        ev?.query ?? null,
        ev?.resultCount ?? null,
        degraded,
        now,
        now,
      )
      .run();
  } catch (error) {
    console.error("[exchanges] failed to record a reconsideration", error);
  }
}

export type ExchangeSummary = {
  /** Every contested purchase, degraded rows included, said out loud or not. */
  challenges: number;
  /** Challenges where a fallback answered rather than a model. Excluded from the rates. */
  degraded: number;
  /** Contests Bucket actually put in front of the person. */
  spoken: number;
  /** Contests the expensive tier dropped by siding with the person against the cheap one. */
  overruled: number;
  /** Contests that stood but fell under the confidence floor, so went unsaid. */
  unsure: number;
  /** Challenges the person answered. */
  answered: number;
  /** Answered challenges where the explanation moved Bucket back to the person's tag. */
  accepted: number;
  /** Answered challenges where Bucket held its position. */
  held: number;
};

const EMPTY_SUMMARY: ExchangeSummary = {
  challenges: 0,
  degraded: 0,
  spoken: 0,
  overruled: 0,
  unsure: 0,
  answered: 0,
  accepted: 0,
  held: 0,
};

/**
 * The counts behind the claim.
 *
 * Deliberately raw. The ratio a reader cares about is `accepted / answered`: how often a
 * challenge did not survive contact with the person's reasoning. Publishing the components
 * rather than the percentage leaves the arithmetic to whoever is checking it.
 */
/**
 * Just the silences, for the public efficiency panel.
 *
 * Separate from {@link readExchangeSummary} because of who reads it. That one feeds a page
 * behind a key, and widening its use would mean deciding case by case which of its fields are
 * safe to publish. This returns three integers and can never return anything else, so it
 * cannot leak a purchase label or somebody's explanation no matter how it is called.
 */
export async function readRestraintCounts(): Promise<{
  spoken: number;
  overruled: number;
  unsure: number;
}> {
  const { spoken, overruled, unsure } = await readExchangeSummary();
  return { spoken, overruled, unsure };
}

export async function readExchangeSummary(): Promise<ExchangeSummary> {
  const db = getDb();
  if (!db) {
    const rows = [...devRows().values()];
    const real = rows.filter((r) => !r.degraded);
    const answered = real.filter((r) => r.answeredAt !== null);
    return {
      challenges: rows.length,
      degraded: rows.length - real.length,
      spoken: rows.filter((r) => r.withheldReason === null).length,
      overruled: rows.filter((r) => r.withheldReason === "overruled").length,
      unsure: rows.filter((r) => r.withheldReason === "unsure").length,
      answered: answered.length,
      accepted: answered.filter((r) => r.explanationAccepted === 1).length,
      held: answered.filter((r) => r.explanationAccepted === 0).length,
    };
  }

  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*)                                           AS challenges,
                COALESCE(SUM(degraded), 0)                         AS degraded,
                COALESCE(SUM(CASE WHEN withheld_reason IS NULL
                                  THEN 1 ELSE 0 END), 0)           AS spoken,
                COALESCE(SUM(CASE WHEN withheld_reason = 'overruled'
                                  THEN 1 ELSE 0 END), 0)           AS overruled,
                COALESCE(SUM(CASE WHEN withheld_reason = 'unsure'
                                  THEN 1 ELSE 0 END), 0)           AS unsure,
                COALESCE(SUM(CASE WHEN degraded = 0 AND answered_at IS NOT NULL
                                  THEN 1 ELSE 0 END), 0)           AS answered,
                COALESCE(SUM(CASE WHEN degraded = 0 AND explanation_accepted = 1
                                  THEN 1 ELSE 0 END), 0)           AS accepted,
                COALESCE(SUM(CASE WHEN degraded = 0 AND explanation_accepted = 0
                                  THEN 1 ELSE 0 END), 0)           AS held
           FROM exchanges`,
      )
      .first<ExchangeSummary>();
    return row ?? EMPTY_SUMMARY;
  } catch (error) {
    console.error("[exchanges] summary read failed", error);
    return EMPTY_SUMMARY;
  }
}

/** Most recent first. No filtering: the point is that the bad ones are here too. */
export async function readExchanges(limit = 100): Promise<ExchangeRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 500);

  const db = getDb();
  if (!db) {
    return [...devRows().values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, capped);
  }

  try {
    const result = await db
      .prepare(
        `SELECT id, amount, label,
                bucket_name          AS bucketName,
                readiness_tag        AS readinessTag,
                user_intent          AS userIntent,
                screening_verdict    AS screeningVerdict,
                screening_confidence AS screeningConfidence,
                screening_reasoning  AS screeningReasoning,
                question, explanation,
                final_verdict        AS finalVerdict,
                final_confidence     AS finalConfidence,
                final_reasoning      AS finalReasoning,
                explanation_accepted AS explanationAccepted,
                withheld_reason      AS withheldReason,
                overruled_verdict    AS overruledVerdict,
                overruled_reasoning  AS overruledReasoning,
                evidence_provider    AS evidenceProvider,
                evidence_query       AS evidenceQuery,
                evidence_results     AS evidenceResults,
                degraded,
                created_at           AS createdAt,
                answered_at          AS answeredAt
           FROM exchanges
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(capped)
      .all<ExchangeRow>();
    return result.results ?? [];
  } catch (error) {
    console.error("[exchanges] read failed", error);
    return [];
  }
}

/**
 * Whether a request may read the exchange log.
 *
 * The app itself has no login, because a judge has to be able to open the URL cold. This log
 * is the one thing that cannot work that way: it holds purchase labels and whatever people
 * typed to explain themselves, and a public page would publish a tester's free text to
 * anyone who found the route.
 *
 * So it takes a key, set as `EXCHANGES_KEY` and passed as `?key=`. The hackathon rules
 * anticipate exactly this ("If Entrant's website is private, Entrant must include login
 * credentials in its testing instructions"), so the key goes in the submission's testing
 * notes and judges get in while the open web does not.
 *
 * Unset means closed, not open. A missing secret is the most likely way this leaks, and
 * defaulting to public would make the quiet failure the dangerous one.
 */
export function exchangeLogUnlocked(suppliedKey: string | null): boolean {
  const expected = getEnvVar("EXCHANGES_KEY")?.trim();
  if (!expected) {
    console.warn("[exchanges] EXCHANGES_KEY is not set — the exchange log is closed");
    return false;
  }
  if (!suppliedKey) return false;

  // Length-independent compare. The timing here barely matters, but a key check that leaks
  // its answer through early exit is a bad habit to leave in a public repo.
  const a = new TextEncoder().encode(suppliedKey);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
