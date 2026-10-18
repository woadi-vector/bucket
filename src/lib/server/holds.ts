import { getDb } from "@/lib/server-env";

/**
 * Storage for PayPal holds. Rows only: no PayPal calls happen here, and no decisions are made.
 * `payments.ts` owns both.
 *
 * The one rule this module enforces is that a hold leaves `held` exactly once. `claim` moves a
 * row from `held` to `deciding` in a single conditional write, and only the caller whose claim
 * succeeded may go on to call PayPal. Two taps on "keep", or a tap racing the expiry sweep,
 * therefore produce one capture or one void, never both.
 */

export type BucketTag = "need" | "want";
export type HoldState = "held" | "deciding" | "captured" | "voided";
export type DecidedBy = "user" | "policy" | "clock";

export type HoldRow = {
  id: string;
  sessionId: string;
  bucketId: string;
  bucketTag: BucketTag;
  label: string;
  merchant: string | null;
  amountCents: number;
  currency: string;
  orderId: string;
  authorizationId: string;
  verdict: "pass" | "hold";
  state: HoldState;
  decidedBy: DecidedBy | null;
  captureId: string | null;
  lastError: string | null;
  createdAt: number;
  deadlineAt: number;
  decidedAt: number | null;
};

/** Development store, held on globalThis like the rest of src/lib/server. */
function devRows(): Map<string, HoldRow> {
  const g = globalThis as { __bucketHolds?: Map<string, HoldRow> };
  if (!g.__bucketHolds) g.__bucketHolds = new Map();
  return g.__bucketHolds;
}

type DbRow = {
  id: string;
  session_id: string;
  bucket_id: string;
  bucket_tag: BucketTag;
  label: string;
  merchant: string | null;
  amount_cents: number;
  currency: string;
  order_id: string;
  authorization_id: string;
  verdict: "pass" | "hold";
  state: HoldState;
  decided_by: DecidedBy | null;
  capture_id: string | null;
  last_error: string | null;
  created_at: number;
  deadline_at: number;
  decided_at: number | null;
};

function fromDb(r: DbRow): HoldRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    bucketId: r.bucket_id,
    bucketTag: r.bucket_tag,
    label: r.label,
    merchant: r.merchant,
    amountCents: r.amount_cents,
    currency: r.currency,
    orderId: r.order_id,
    authorizationId: r.authorization_id,
    verdict: r.verdict,
    state: r.state,
    decidedBy: r.decided_by,
    captureId: r.capture_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    deadlineAt: r.deadline_at,
    decidedAt: r.decided_at,
  };
}

/**
 * Records a hold PayPal has already placed.
 *
 * Unlike the exchange log, this write is allowed to throw. A hold that exists at PayPal but not
 * here is money reserved with no way to release it from the app, so the caller has to know.
 */
export async function insertHold(row: HoldRow): Promise<void> {
  const db = getDb();
  if (!db) {
    devRows().set(row.id, { ...row });
    return;
  }
  await db
    .prepare(
      `INSERT INTO holds
         (id, session_id, bucket_id, bucket_tag, label, merchant, amount_cents, currency,
          order_id, authorization_id, verdict, state, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.sessionId,
      row.bucketId,
      row.bucketTag,
      row.label,
      row.merchant,
      row.amountCents,
      row.currency,
      row.orderId,
      row.authorizationId,
      row.verdict,
      row.state,
      row.createdAt,
      row.deadlineAt,
    )
    .run();
}

export async function getHold(id: string): Promise<HoldRow | null> {
  const db = getDb();
  if (!db) {
    const row = devRows().get(id);
    return row ? { ...row } : null;
  }
  const row = await db.prepare("SELECT * FROM holds WHERE id = ?").bind(id).first<DbRow>();
  return row ? fromDb(row) : null;
}

/**
 * Moves a hold from `held` to `deciding`. Returns true only for the caller that won.
 *
 * Optionally scoped to a session, so a hold id from one visitor cannot be acted on from
 * another's cookie.
 */
export async function claim(id: string, sessionId?: string): Promise<boolean> {
  const db = getDb();
  if (!db) {
    const row = devRows().get(id);
    if (!row || row.state !== "held") return false;
    if (sessionId !== undefined && row.sessionId !== sessionId) return false;
    row.state = "deciding";
    return true;
  }
  const result =
    sessionId === undefined
      ? await db
          .prepare("UPDATE holds SET state = 'deciding' WHERE id = ? AND state = 'held'")
          .bind(id)
          .run()
      : await db
          .prepare(
            "UPDATE holds SET state = 'deciding' WHERE id = ? AND state = 'held' AND session_id = ?",
          )
          .bind(id, sessionId)
          .run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Final state after PayPal confirmed the capture or void. Only from `deciding`. */
export async function settle(
  id: string,
  outcome: { state: "captured" | "voided"; decidedBy: DecidedBy; captureId?: string },
): Promise<void> {
  const now = Date.now();
  const db = getDb();
  if (!db) {
    const row = devRows().get(id);
    if (!row || row.state !== "deciding") return;
    row.state = outcome.state;
    row.decidedBy = outcome.decidedBy;
    row.captureId = outcome.captureId ?? null;
    row.decidedAt = now;
    row.lastError = null;
    return;
  }
  await db
    .prepare(
      `UPDATE holds SET state = ?, decided_by = ?, capture_id = ?, decided_at = ?, last_error = NULL
       WHERE id = ? AND state = 'deciding'`,
    )
    .bind(outcome.state, outcome.decidedBy, outcome.captureId ?? null, now, id)
    .run();
}

/**
 * PayPal refused or failed. The hold goes back to `held` with the error recorded, so the money
 * is still reserved, still visible, and the person or the sweep can try again.
 */
export async function release(id: string, error: string): Promise<void> {
  const message = error.slice(0, 500);
  const db = getDb();
  if (!db) {
    const row = devRows().get(id);
    if (!row || row.state !== "deciding") return;
    row.state = "held";
    row.lastError = message;
    return;
  }
  await db
    .prepare("UPDATE holds SET state = 'held', last_error = ? WHERE id = ? AND state = 'deciding'")
    .bind(message, id)
    .run();
}

/** Held rows whose deadline has passed: what the scheduled sweep voids. */
export async function listDue(now: number, limit = 50): Promise<HoldRow[]> {
  const db = getDb();
  if (!db) {
    return [...devRows().values()]
      .filter((r) => r.state === "held" && r.deadlineAt <= now)
      .sort((a, b) => a.deadlineAt - b.deadlineAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  const { results } = await db
    .prepare(
      "SELECT * FROM holds WHERE state = 'held' AND deadline_at <= ? ORDER BY deadline_at LIMIT ?",
    )
    .bind(now, limit)
    .all<DbRow>();
  return results.map(fromDb);
}

/** Newest first. The public ledger reads this; nothing is filtered out. */
export async function listHolds(limit = 100): Promise<HoldRow[]> {
  const db = getDb();
  if (!db) {
    return [...devRows().values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  const { results } = await db
    .prepare("SELECT * FROM holds ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<DbRow>();
  return results.map(fromDb);
}

/** One visitor's holds, newest first. What the Sleep On It tray reads. */
export async function listHoldsForSession(sessionId: string, limit = 50): Promise<HoldRow[]> {
  const db = getDb();
  if (!db) {
    return [...devRows().values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  const { results } = await db
    .prepare("SELECT * FROM holds WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(sessionId, limit)
    .all<DbRow>();
  return results.map(fromDb);
}

/** A hold as anyone may see it: no session id, nothing that links a row to a visitor. */
export type PublicHold = Omit<HoldRow, "sessionId">;

export const toPublicHold = ({ sessionId: _sessionId, ...rest }: HoldRow): PublicHold => rest;
