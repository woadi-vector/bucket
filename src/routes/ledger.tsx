import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { readLedger } from "@/lib/bucket/hold-fns";
import { toLedgerRows } from "@/lib/bucket/ledger-rows";

/**
 * Every PayPal hold Bucket has placed, and every purchase the agent refused before PayPal was
 * called, newest first.
 *
 * Each hold carries PayPal's authorization id, so anyone can check a row against PayPal's record
 * instead of believing this page. Releases and refusals are listed beside captures: a purchase
 * that never happened is the outcome the app exists to produce, so hiding those rows would hide
 * the point.
 *
 * Public, with no key: rows hold the product, the amount, the bucket tag and the decision, and no
 * visitor identifier. The same data is at /api/ledger as JSON.
 */
export const Route = createFileRoute("/ledger")({
  loader: () => readLedger(),
  head: () => ({
    meta: [
      { title: "Bucket · PayPal ledger" },
      {
        name: "description",
        content:
          "Every PayPal hold Bucket has placed, every purchase it refused, and what became of each.",
      },
    ],
  }),
  component: LedgerPage,
});

// AG Grid and AG Charts load in the browser only, after the page has rendered.
const LedgerBoard = lazy(() => import("@/components/bucket/LedgerBoard"));

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Tile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e7e4da] bg-white px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function LedgerPage() {
  const data = Route.useLoaderData();
  const rows = useMemo(() => toLedgerRows(data), [data]);
  const t = data.totals;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const released = t.releasedByPerson + t.releasedByClock;

  return (
    <main className="min-h-screen bg-[#faf9f4] text-[#1c2a24]">
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
        <p className="text-sm">
          <Link to="/" className="text-slate-500 hover:text-[#0b7a58]">
            ← Bucket
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">PayPal ledger</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
          Every hold Bucket's shopping agent placed through PayPal (sandbox), and every purchase it
          refused before PayPal was called. Each authorization id is PayPal's own, so any row can be
          checked against PayPal's record. Nothing is removed: released holds and refusals stay on
          the list. Raw JSON:{" "}
          <a href="/api/ledger" className="font-medium text-[#0b7a58] underline">
            /api/ledger
          </a>
          .
        </p>

        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile
            label="Money moved"
            value={usd(t.capturedCents)}
            sub={`${t.captured} captured`}
            color="#475569"
          />
          <Tile
            label="Released by Bucket"
            value={usd(t.releasedCents)}
            sub={`${released} voided · ${t.releasedByPerson} let go, ${t.releasedByClock} by the clock`}
            color="#0b7a58"
          />
          <Tile
            label="Reserved, waiting"
            value={String(t.waiting)}
            sub="holds open right now"
            color="#d97706"
          />
          <Tile
            label="Never reached PayPal"
            value={String(t.declined + t.overruled)}
            sub={`${t.declined} declined · ${t.overruled} overruled (${usd(t.overruledCents)})`}
            color="#7c6bb0"
          />
        </div>

        <div className="mt-6">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">No holds or refusals yet.</p>
          ) : mounted ? (
            <Suspense fallback={<p className="text-sm text-slate-500">Loading the table…</p>}>
              <LedgerBoard rows={rows} />
            </Suspense>
          ) : (
            <p className="text-sm text-slate-500">Loading the table…</p>
          )}
        </div>
      </div>
    </main>
  );
}
