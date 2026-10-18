import { getEnvVar } from "@/lib/server-env";
import {
  claim,
  getHold,
  insertHold,
  listDue,
  release,
  settle,
  type BucketTag,
  type DecidedBy,
  type HoldRow,
} from "@/lib/server/holds";
import {
  captureAuthorization,
  createAuthorizedOrder,
  getAuthorizationStatus,
  voidAuthorization,
} from "@/lib/server/paypal";

/**
 * The only module in Bucket that moves money.
 *
 * Three operations reach PayPal: place a hold, keep it (capture), let it go (void). Each is a
 * plain function called by server code, and none is a tool a model can call. The screen's
 * output reaches this file as one of two words, "pass" or "hold", already decided; a model
 * never names a capture or a void. `scripts/check-payments.mjs` fails the build if anything in
 * this file's import graph comes from the engine, so the boundary is tested, not promised.
 */

/**
 * How long a want waits in Sleep On It. 24 hours in the product. The demo sets
 * HOLD_WINDOW_MINUTES to a few minutes so a judge can watch a hold expire.
 *
 * Capped well inside PayPal's 3-day honor period, after which a capture is no longer
 * guaranteed to succeed.
 */
const DEFAULT_WINDOW_MINUTES = 24 * 60;
const MAX_WINDOW_MINUTES = 3 * 24 * 60 - 60;

export function holdWindowMs(): number {
  const raw = Number(getEnvVar("HOLD_WINDOW_MINUTES"));
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MINUTES;
  return Math.min(minutes, MAX_WINDOW_MINUTES) * 60_000;
}

/**
 * What the clock does to a hold nobody decided on.
 *
 * Void: the money goes back. Fail-closed, and true to the thesis that an unconsidered want
 * should not complete itself. The alternative is capture by default. This is an open product
 * decision recorded in the spec; changing it is changing this one constant.
 */
export const ON_EXPIRY: "void" | "capture" = "void";

export type DecisionResult =
  | { ok: true; hold: HoldRow }
  | {
      ok: false;
      reason: "not-found" | "not-held" | "expired" | "paypal-error";
      hold: HoldRow | null;
      error?: string;
    };

// --- Placing a hold ----------------------------------------------------------------------------

export type PlaceHoldInput = {
  sessionId: string;
  bucketId: string;
  bucketTag: BucketTag;
  label: string;
  merchant?: string | null;
  amountCents: number;
  currency?: string;
  /** The saved PayPal wallet the purchase is paid from. */
  vaultId: string;
  /** The screen's decision, already made. "pass" captures at once; "hold" waits. */
  verdict: "pass" | "hold";
};

/**
 * Asks PayPal to reserve the money, records the hold, and captures it straight away when the
 * screen passed it.
 *
 * If PayPal placed the hold but the row cannot be written, the hold is voided before the error
 * goes up. Money reserved with no record of it is the one state this module refuses to leave
 * behind.
 */
export async function placeHold(input: PlaceHoldInput): Promise<HoldRow> {
  const id = crypto.randomUUID();
  const now = Date.now();

  const order = await createAuthorizedOrder({
    vaultId: input.vaultId,
    amountCents: input.amountCents,
    currency: input.currency,
    bucketId: input.bucketId,
    description: input.label,
    requestId: `${id}:authorize`,
  });

  const row: HoldRow = {
    id,
    sessionId: input.sessionId,
    bucketId: input.bucketId,
    bucketTag: input.bucketTag,
    label: input.label.slice(0, 200),
    merchant: input.merchant?.slice(0, 200) ?? null,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    orderId: order.orderId,
    authorizationId: order.authorizationId,
    verdict: input.verdict,
    state: "held",
    decidedBy: null,
    captureId: null,
    lastError: null,
    createdAt: now,
    deadlineAt: now + holdWindowMs(),
    decidedAt: null,
  };

  try {
    await insertHold(row);
  } catch (error) {
    console.error("[payments] hold placed but not recorded; voiding it", error);
    await voidAuthorization(order.authorizationId, `${id}:void`).catch((voidError) =>
      console.error(
        "[payments] could not void an unrecorded hold",
        order.authorizationId,
        voidError,
      ),
    );
    throw error;
  }

  if (input.verdict === "pass") {
    const result = await keep(id, { decidedBy: "policy" });
    if (result.hold) return result.hold;
  }
  return row;
}

// --- Deciding ------------------------------------------------------------------------------

/** The person kept it, or the screen passed it: capture. */
export function keep(
  id: string,
  opts: { decidedBy: DecidedBy; sessionId?: string },
): Promise<DecisionResult> {
  return decide(id, "capture", opts);
}

/** The person let it go: void, and the money goes back. */
export function letGo(
  id: string,
  opts: { decidedBy: DecidedBy; sessionId?: string },
): Promise<DecisionResult> {
  return decide(id, "void", opts);
}

/**
 * Claims the hold, calls PayPal once, and records the outcome.
 *
 * The PayPal request id is derived from the hold and the action, so a retry after a timeout
 * repeats the original request instead of issuing a second one. When PayPal errors, Bucket asks
 * PayPal what state the hold is actually in before deciding what to record: a capture that
 * succeeded but whose response was lost must be recorded as captured, not retried as a void.
 */
async function decide(
  id: string,
  action: "capture" | "void",
  opts: { decidedBy: DecidedBy; sessionId?: string },
): Promise<DecisionResult> {
  const before = await getHold(id);
  if (!before) return { ok: false, reason: "not-found", hold: null };
  if (opts.sessionId !== undefined && before.sessionId !== opts.sessionId) {
    // Indistinguishable from a missing hold on purpose: one visitor learns nothing about
    // another's holds by guessing ids.
    return { ok: false, reason: "not-found", hold: null };
  }

  // A person cannot keep a want after its window closed, even if the sweep has not reached it
  // yet. The clock's decision wins: the hold is ended the way ON_EXPIRY says, by the clock, and
  // the person is told it expired. Without this, "24 hours to decide" would only be true when
  // the sweep happened to run on time.
  if (
    action === "capture" &&
    opts.decidedBy === "user" &&
    before.state === "held" &&
    Date.now() >= before.deadlineAt
  ) {
    const ended = await decide(id, ON_EXPIRY, { decidedBy: "clock" });
    return { ok: false, reason: "expired", hold: ended.hold };
  }

  if (!(await claim(id, opts.sessionId))) {
    return { ok: false, reason: "not-held", hold: await getHold(id) };
  }

  try {
    if (action === "capture") {
      const { captureId } = await captureAuthorization(before.authorizationId, `${id}:capture`);
      await settle(id, { state: "captured", decidedBy: opts.decidedBy, captureId });
    } else {
      await voidAuthorization(before.authorizationId, `${id}:void`);
      await settle(id, { state: "voided", decidedBy: opts.decidedBy });
    }
    return { ok: true, hold: (await getHold(id)) as HoldRow };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reconciled = await reconcile(id, before.authorizationId, opts.decidedBy);
    if (reconciled) return { ok: true, hold: reconciled };

    await release(id, message);
    return { ok: false, reason: "paypal-error", hold: await getHold(id), error: message };
  }
}

/**
 * After a failed call, records whatever PayPal says actually happened. Returns the settled row,
 * or null when the hold is genuinely still open (or PayPal cannot be reached to say).
 */
async function reconcile(
  id: string,
  authorizationId: string,
  decidedBy: DecidedBy,
): Promise<HoldRow | null> {
  let status: string;
  try {
    status = await getAuthorizationStatus(authorizationId);
  } catch {
    return null;
  }
  if (status === "CAPTURED" || status === "PARTIALLY_CAPTURED") {
    await settle(id, { state: "captured", decidedBy });
  } else if (status === "VOIDED" || status === "EXPIRED") {
    await settle(id, { state: "voided", decidedBy });
  } else {
    return null;
  }
  return getHold(id);
}

// --- The clock -------------------------------------------------------------------------------

/**
 * Ends every held purchase whose deadline has passed. Run by the scheduled sweep.
 *
 * Returns what it did, row by row, so the sweep's log is a record rather than a count.
 */
export async function sweepExpired(
  now = Date.now(),
): Promise<{ id: string; ok: boolean; reason?: string }[]> {
  const due = await listDue(now);
  const results: { id: string; ok: boolean; reason?: string }[] = [];
  for (const hold of due) {
    const result =
      ON_EXPIRY === "void"
        ? await letGo(hold.id, { decidedBy: "clock" })
        : await keep(hold.id, { decidedBy: "clock" });
    results.push(
      result.ok ? { id: hold.id, ok: true } : { id: hold.id, ok: false, reason: result.reason },
    );
  }
  return results;
}
