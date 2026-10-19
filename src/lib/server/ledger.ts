import { listHolds, toPublicHold, type PublicHold } from "@/lib/server/holds";
import { countRefusals, listRefusals, type Refusal } from "@/lib/server/refusals";
import { sweepExpired } from "@/lib/server/payments";

/**
 * The public ledger in one read: every PayPal hold, every refusal that never reached PayPal, and
 * the counts both add up to. The page and /api/ledger serve exactly this, so the JSON a judge
 * downloads is the data the grid shows.
 */

export type LedgerTotals = {
  holds: number;
  captured: number;
  capturedCents: number;
  /** Voided because the person said let it go. */
  releasedByPerson: number;
  /** Voided because the window ran out. */
  releasedByClock: number;
  releasedCents: number;
  waiting: number;
  declined: number;
  overruled: number;
  /** What the agent would have spent on the items the second check refused. */
  overruledCents: number;
};

export type LedgerData = {
  holds: PublicHold[];
  refusals: Refusal[];
  totals: LedgerTotals;
  generatedAt: string;
};

export function totalsOf(holds: PublicHold[], refusals: Refusal[]): LedgerTotals {
  const captured = holds.filter((h) => h.state === "captured");
  const voided = holds.filter((h) => h.state === "voided");
  const overruled = refusals.filter((r) => r.kind === "overruled");
  return {
    holds: holds.length,
    captured: captured.length,
    capturedCents: captured.reduce((s, h) => s + h.amountCents, 0),
    releasedByPerson: voided.filter((h) => h.decidedBy !== "clock").length,
    releasedByClock: voided.filter((h) => h.decidedBy === "clock").length,
    releasedCents: voided.reduce((s, h) => s + h.amountCents, 0),
    waiting: holds.filter((h) => h.state === "held" || h.state === "deciding").length,
    declined: refusals.filter((r) => r.kind === "declined").length,
    overruled: overruled.length,
    overruledCents: overruled.reduce((s, r) => s + (r.priceCents ?? 0), 0),
  };
}

export async function readLedgerData(): Promise<LedgerData> {
  try {
    await sweepExpired();
  } catch (error) {
    // A failed sweep must not stop anyone reading the ledger. The next read tries again.
    console.error("[ledger] sweep failed", error);
  }
  const [rows, refusals] = await Promise.all([listHolds(200), listRefusals(200)]);
  const holds = rows.map(toPublicHold);
  return {
    holds,
    refusals,
    totals: totalsOf(holds, refusals),
    generatedAt: new Date().toISOString(),
  };
}

/** Everything Bucket has held back: refusals plus holds that were let go. */
export async function heldBackCount(): Promise<number> {
  const [refused, rows] = await Promise.all([countRefusals(), listHolds(500)]);
  return refused + rows.filter((h) => h.state === "voided").length;
}
