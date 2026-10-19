import { createServerFn } from "@tanstack/react-start";
import { getOrCreateSessionId } from "@/lib/server/session";
import { listHoldsForSession, toPublicHold, type PublicHold } from "@/lib/server/holds";
import { keep, letGo, sweepExpired, type DecisionResult } from "@/lib/server/payments";
import { readLedgerData, type LedgerData } from "@/lib/server/ledger";

/**
 * The app's handle on PayPal holds: read your own, keep one, let one go, and read the public
 * ledger.
 *
 * Every call that reads holds sweeps expired ones first. Bucket's clock is enforced whenever
 * anyone looks, not only when a scheduled job happens to run, so a judge watching a hold's
 * countdown reach zero sees it voided on the next refresh.
 */

export type { PublicHold, LedgerData };

async function sweep(): Promise<void> {
  try {
    await sweepExpired();
  } catch (error) {
    // A failed sweep must not stop anyone reading their holds. The next read tries again.
    console.error("[holds] sweep failed", error);
  }
}

export const readMyHolds = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicHold[]> => {
    await sweep();
    const rows = await listHoldsForSession(getOrCreateSessionId());
    return rows.map(toPublicHold);
  },
);

export type HoldDecision =
  | { ok: true; hold: PublicHold }
  | { ok: false; reason: Exclude<DecisionResult, { ok: true }>["reason"]; hold: PublicHold | null };

function validateId(data: unknown): { id: string } {
  if (typeof data !== "object" || data === null) throw new Error("Invalid request");
  const { id } = data as Record<string, unknown>;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid hold id");
  return { id };
}

function toDecision(result: DecisionResult): HoldDecision {
  if (result.ok) return { ok: true, hold: toPublicHold(result.hold) };
  // The PayPal error text stays in the server log and the holds row. The browser gets the
  // reason, which is all it can act on.
  return { ok: false, reason: result.reason, hold: result.hold ? toPublicHold(result.hold) : null };
}

/** The person kept a held want: capture it. */
export const keepHold = createServerFn({ method: "POST" })
  .inputValidator(validateId)
  .handler(async ({ data }): Promise<HoldDecision> =>
    toDecision(await keep(data.id, { decidedBy: "user", sessionId: getOrCreateSessionId() })),
  );

/** The person let a held want go: void it, and the money goes back. */
export const letGoHold = createServerFn({ method: "POST" })
  .inputValidator(validateId)
  .handler(async ({ data }): Promise<HoldDecision> =>
    toDecision(await letGo(data.id, { decidedBy: "user", sessionId: getOrCreateSessionId() })),
  );

/** The public ledger: every hold, every refusal, and the totals. The same data as /api/ledger. */
export const readLedger = createServerFn({ method: "GET" }).handler(async (): Promise<LedgerData> =>
  readLedgerData(),
);
