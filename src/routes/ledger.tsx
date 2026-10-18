import { createFileRoute, Link } from "@tanstack/react-router";
import { readLedger, type PublicHold } from "@/lib/bucket/hold-fns";

/**
 * Every PayPal hold Bucket has placed, newest first.
 *
 * Evidence, not product, and plain on purpose, like the exchange log. Each row carries PayPal's
 * authorization id, so anyone can check a row against PayPal's record instead of believing this
 * page. Releases are listed beside captures: a purchase the person let go is the outcome the app
 * exists to produce, so hiding those rows would hide the point.
 *
 * Public, with no key: rows hold the product, the amount, the bucket and the decision, and no
 * visitor identifier. The same data is at /api/ledger as JSON.
 */
export const Route = createFileRoute("/ledger")({
  loader: () => readLedger(),
  head: () => ({
    meta: [
      { title: "Bucket · PayPal ledger" },
      {
        name: "description",
        content: "Every PayPal hold Bucket has placed, and what became of it.",
      },
    ],
  }),
  component: LedgerPage,
});

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function outcome(h: PublicHold): string {
  if (h.state === "held") return "held, waiting";
  if (h.state === "deciding") return "deciding";
  const by =
    h.decidedBy === "clock"
      ? "the clock ran out"
      : h.decidedBy === "policy"
        ? "a need, passed at once"
        : "the person decided";
  return `${h.state === "captured" ? "captured" : "released (voided)"} · ${by}`;
}

function LedgerPage() {
  const holds = Route.useLoaderData();
  const captured = holds.filter((h) => h.state === "captured");
  const released = holds.filter((h) => h.state === "voided");
  const keptCents = released.reduce((s, h) => s + h.amountCents, 0);

  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "2.5rem 1rem 4rem",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        lineHeight: 1.5,
      }}
    >
      <p style={{ fontSize: "0.8rem" }}>
        <Link to="/">← Bucket</Link>
      </p>
      <h1 style={{ fontSize: "1.5rem", margin: "0.5rem 0" }}>PayPal ledger</h1>
      <p style={{ color: "#444", maxWidth: 640 }}>
        Every hold Bucket's shopping agent placed through PayPal (sandbox), and what became of it.
        Each authorization id below is PayPal's own, so any row can be checked against PayPal's
        record. Released holds are kept on the list. Raw JSON: <a href="/api/ledger">/api/ledger</a>
        .
      </p>

      <p style={{ margin: "1.25rem 0", fontSize: "0.95rem" }}>
        <strong>{holds.length}</strong> holds · <strong>{captured.length}</strong> captured ·{" "}
        <strong>{released.length}</strong> released, keeping <strong>{usd(keptCents)}</strong> in
        people's pockets.
      </p>

      {holds.length === 0 ? (
        <p style={{ color: "#777" }}>No holds yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #ccc" }}>
                <th style={{ padding: "0.4rem" }}>When</th>
                <th style={{ padding: "0.4rem" }}>Purchase</th>
                <th style={{ padding: "0.4rem" }}>Bucket</th>
                <th style={{ padding: "0.4rem", textAlign: "right" }}>Amount</th>
                <th style={{ padding: "0.4rem" }}>Outcome</th>
                <th style={{ padding: "0.4rem" }}>PayPal authorization</th>
              </tr>
            </thead>
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                  <td style={{ padding: "0.4rem", whiteSpace: "nowrap", color: "#555" }}>
                    {when(h.createdAt)}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {h.label}
                    {h.merchant ? <div style={{ color: "#777" }}>{h.merchant}</div> : null}
                  </td>
                  <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>
                    <code>{h.bucketId}</code> · {h.bucketTag}
                  </td>
                  <td style={{ padding: "0.4rem", textAlign: "right" }}>{usd(h.amountCents)}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {outcome(h)}
                    {h.lastError ? (
                      <div style={{ color: "#a33" }}>last PayPal error: {h.lastError}</div>
                    ) : null}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    <code>{h.authorizationId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
