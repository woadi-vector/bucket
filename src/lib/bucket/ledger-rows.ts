import type { LedgerData, PublicHold } from "@/lib/bucket/hold-fns";

/**
 * One row of the ledger grid. Holds (money that reached PayPal) and refusals (purchases the
 * agent held back before PayPal was called) share one table, so a reader can sort or filter the
 * whole record at once instead of reading two lists and adding them up.
 *
 * Pure and client-safe: types only, no server imports.
 */

export type Outcome =
  "Paid at once" | "Kept" | "Let go" | "Expired" | "Waiting" | "Declined" | "Overruled";

/** Every outcome, in the order the filter chips and the chart show them. */
export const OUTCOMES: Outcome[] = [
  "Paid at once",
  "Kept",
  "Let go",
  "Expired",
  "Waiting",
  "Overruled",
  "Declined",
];

/** Whether money moved, was reserved, was returned, or never left. Drives the row colors. */
export type OutcomeGroup = "paid" | "waiting" | "released" | "refused";

export const GROUP_OF: Record<Outcome, OutcomeGroup> = {
  "Paid at once": "paid",
  Kept: "paid",
  "Let go": "released",
  Expired: "released",
  Waiting: "waiting",
  Declined: "refused",
  Overruled: "refused",
};

export type LedgerRow = {
  id: string;
  at: number;
  source: "PayPal hold" | "Refused before PayPal";
  /** The purchase for a hold; what was asked for on a refusal. */
  what: string;
  /** Merchant for a hold; the product the second check refused, for an overrule. */
  detail: string | null;
  tag: "need" | "want" | null;
  /** Null on a decline: nothing was picked, so nothing was priced. */
  amountCents: number | null;
  outcome: Outcome;
  group: OutcomeGroup;
  /** Who or what decided: the person, the clock, the rule, or a model's refusal. */
  decidedBy: string;
  /** A refusal's stated reason; a hold's last PayPal error, if any. */
  note: string | null;
  authorizationId: string | null;
  captureId: string | null;
};

function holdOutcome(h: PublicHold): Outcome {
  if (h.state === "held" || h.state === "deciding") return "Waiting";
  if (h.state === "captured") return h.decidedBy === "user" ? "Kept" : "Paid at once";
  return h.decidedBy === "clock" ? "Expired" : "Let go";
}

function holdDecidedBy(h: PublicHold): string {
  if (h.state === "held" || h.state === "deciding") return "Not yet";
  if (h.decidedBy === "clock") return "The clock";
  if (h.decidedBy === "user") return "The person";
  return h.bucketTag === "need" ? "Rule: a need passes" : "Rule: a want under its threshold";
}

export function toLedgerRows(data: LedgerData): LedgerRow[] {
  const holds: LedgerRow[] = data.holds.map((h) => {
    const outcome = holdOutcome(h);
    return {
      id: h.id,
      at: h.createdAt,
      source: "PayPal hold",
      what: h.label,
      detail: h.merchant ?? null,
      tag: h.bucketTag,
      amountCents: h.amountCents,
      outcome,
      group: GROUP_OF[outcome],
      decidedBy: holdDecidedBy(h),
      note:
        [h.pushback?.join(" ") || null, h.lastError ? `Last PayPal error: ${h.lastError}` : null]
          .filter(Boolean)
          .join(" ") || null,
      authorizationId: h.authorizationId,
      captureId: h.captureId ?? null,
    };
  });
  const refusals: LedgerRow[] = data.refusals.map((r) => {
    const outcome: Outcome = r.kind === "overruled" ? "Overruled" : "Declined";
    return {
      id: r.id,
      at: r.createdAt,
      source: "Refused before PayPal",
      what: `“${r.request}”`,
      detail: r.productTitle,
      tag: null,
      amountCents: r.priceCents,
      outcome,
      group: "refused",
      decidedBy: r.kind === "overruled" ? "Second check (Nano)" : "Agent (Super)",
      note: r.reason,
      authorizationId: null,
      captureId: null,
    };
  });
  return [...holds, ...refusals].sort((a, b) => b.at - a.at);
}

/** Dollars per outcome, for the chart. A decline has no price, so it contributes a count only. */
export function dollarsByOutcome(rows: LedgerRow[]) {
  return OUTCOMES.map((outcome) => {
    const these = rows.filter((r) => r.outcome === outcome);
    return {
      outcome,
      group: GROUP_OF[outcome],
      count: these.length,
      dollars: these.reduce((s, r) => s + (r.amountCents ?? 0), 0) / 100,
    };
  });
}
