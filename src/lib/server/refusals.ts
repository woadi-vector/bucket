import { getDb } from "@/lib/server-env";

/**
 * Purchases the agent held back before PayPal was ever called: a decline (nothing listed was
 * what was asked for) or an overrule (the agent picked something and the second check said no).
 *
 * The holds table only knows about money that reached PayPal. These rows are the other half of
 * the record, so the ledger can count what Bucket refused as well as what it held. A model
 * reporting that it is careful cannot produce this list; only the refusals themselves can.
 *
 * Unlike holds, a failed write here is logged and swallowed. A missing refusal row costs a line
 * on the ledger; it never strands money.
 */

export type RefusalKind = "declined" | "overruled";

export type Refusal = {
  id: string;
  kind: RefusalKind;
  request: string;
  maxCents: number | null;
  productTitle: string | null;
  priceCents: number | null;
  merchant: string | null;
  category: string | null;
  reason: string;
  considered: number;
  createdAt: number;
};

type DbRow = {
  id: string;
  kind: RefusalKind;
  request: string;
  max_cents: number | null;
  product_title: string | null;
  price_cents: number | null;
  merchant: string | null;
  category: string | null;
  reason: string;
  considered: number;
  created_at: number;
};

const fromDb = (r: DbRow): Refusal => ({
  id: r.id,
  kind: r.kind,
  request: r.request,
  maxCents: r.max_cents,
  productTitle: r.product_title,
  priceCents: r.price_cents,
  merchant: r.merchant,
  category: r.category,
  reason: r.reason,
  considered: r.considered,
  createdAt: r.created_at,
});

function devRows(): Refusal[] {
  const g = globalThis as { __bucketRefusals?: Refusal[] };
  if (!g.__bucketRefusals) g.__bucketRefusals = [];
  return g.__bucketRefusals;
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export async function recordRefusal(input: Omit<Refusal, "id" | "createdAt">): Promise<Refusal> {
  const row: Refusal = {
    ...input,
    id: crypto.randomUUID(),
    request: clip(input.request, 120),
    productTitle: input.productTitle ? clip(input.productTitle, 140) : null,
    reason: clip(input.reason || "No reason given.", 300),
    createdAt: Date.now(),
  };
  const db = getDb();
  if (!db) {
    devRows().unshift(row);
    return row;
  }
  try {
    await db
      .prepare(
        `INSERT INTO refusals
           (id, kind, request, max_cents, product_title, price_cents, merchant, category,
            reason, considered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.kind,
        row.request,
        row.maxCents,
        row.productTitle,
        row.priceCents,
        row.merchant,
        row.category,
        row.reason,
        row.considered,
        row.createdAt,
      )
      .run();
  } catch (error) {
    console.error("[refusals] write failed", error);
  }
  return row;
}

/** Newest first. Public: no row carries a visitor identifier. */
export async function listRefusals(limit = 200): Promise<Refusal[]> {
  const db = getDb();
  if (!db)
    return devRows()
      .slice(0, limit)
      .map((r) => ({ ...r }));
  try {
    const { results } = await db
      .prepare("SELECT * FROM refusals ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<DbRow>();
    return results.map(fromDb);
  } catch (error) {
    // Before the migration is applied the table does not exist. The ledger still shows holds.
    console.error("[refusals] read failed", error);
    return [];
  }
}

/** How many refusals there are in all, for the counter beside the shop card. */
export async function countRefusals(): Promise<number> {
  const db = getDb();
  if (!db) return devRows().length;
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM refusals").first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
