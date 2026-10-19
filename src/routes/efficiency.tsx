import { createFileRoute, Link } from "@tanstack/react-router";
import { readEfficiency, type EfficiencyReport } from "@/lib/bucket/efficiency-fns";
import { formatMicros, formatRate } from "@/lib/efficiency";

/**
 * What the tiering cost, and what it would have cost without it.
 *
 * Evidence, not product, so it matches `/exchanges`: plain, monospace, no palette, no motion.
 * Someone checking whether model routing is a real decision or a sentence in a README should
 * be reading numbers, not admiring a layout.
 *
 * Unlike the exchange log this page takes no key. It holds call counts, tokens and money, and
 * nothing about any person or any purchase, so there is nothing here to protect and every
 * reason to let a stranger open it.
 */

export const Route = createFileRoute("/efficiency")({
  loader: () => readEfficiency(),
  component: EfficiencyPage,
});

const ms = (value: number | null) => (value === null ? "not recorded" : `${Math.round(value)}ms`);

/** The tiers in the order they are reached, so the table reads as the path a verdict takes. */
const ORDER = ["nano", "ultra", "stub"];

const LABEL: Record<string, string> = {
  nano: "Screening (Nemotron 3 Nano 30B)",
  ultra: "Adjudication (Nemotron 3 Ultra 550B)",
  stub: "Stub (no model consulted)",
};

function EfficiencyPage() {
  const report = Route.useLoaderData() as EfficiencyReport;

  const page = {
    maxWidth: "46rem",
    margin: "0 auto",
    padding: "2rem 1rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9rem",
    lineHeight: 1.5,
    color: "#111",
    background: "#fff",
    minHeight: "100vh",
  } as const;

  const cell = { padding: "0.4rem 0.75rem 0.4rem 0", textAlign: "left" } as const;
  const num = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" } as const;

  const tiers = [...report.tiers].sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier));

  return (
    <main style={page}>
      <h1 style={{ fontSize: "1.1rem" }}>What Bucket spent</h1>

      <p>
        Every judgement starts at the small model. The large one is reached only when the small one
        contests what a person said about their own money, which is an unusual reason to escalate:
        not that the task looked hard, but that a human disagreed. This page is the ledger behind
        that, read straight out of the table the app writes as it runs.
      </p>

      {report.verdicts === 0 ? (
        <p style={{ marginTop: "1.5rem" }}>
          Nothing recorded yet. Judge a purchase and this fills in.
        </p>
      ) : (
        <>
          <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>The split</h2>
          <ul style={{ paddingLeft: "1.25rem" }}>
            <li>Purchases judged: {report.verdicts}</li>
            <li>
              Of those, escalated to the large model: {report.escalations} (
              {formatRate(report.escalationRate)})
            </li>
            <li>
              Escalations where the large model sided with the person and the objection was dropped:{" "}
              {report.overruled}
            </li>
          </ul>

          <p style={{ color: "#555" }}>
            That last line is what the expensive call bought on those occasions. Not a better answer
            shown to someone, but an argument withdrawn before they ever saw it. The individual
            cases are in the{" "}
            <Link to="/exchanges" search={{ key: undefined }}>
              exchange log
            </Link>
            , which needs a key.
          </p>

          <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>Per tier</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #ddd" }}>
                <th style={cell}>Tier</th>
                <th style={num}>Calls</th>
                <th style={num}>Tokens</th>
                <th style={num}>Cost</th>
                <th style={num}>Mean latency</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.tier} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={cell}>{LABEL[t.tier] ?? t.tier}</td>
                  <td style={num}>{t.calls}</td>
                  <td style={num}>{t.totalTokens.toLocaleString()}</td>
                  <td style={num}>{formatMicros(t.costMicros)}</td>
                  <td style={num}>{ms(t.avgLatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ color: "#555" }}>
            Degraded calls are excluded: a fallback is not the model answering, and counting one
            would credit a tier that never ran. Cost is this app's own estimate rather than Nebius
            billing, because Token Factory does not return pricing with a response.
          </p>

          <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>What routing was worth</h2>

          {report.counterfactualMicros === null ? (
            <p>
              Not computable yet. Nothing has escalated, so there is no observed rate for the large
              model and any figure here would be a guess dressed as a measurement.
            </p>
          ) : (
            <>
              <ul style={{ paddingLeft: "1.25rem" }}>
                <li>Screening actually cost: {formatMicros(tiers[0]?.costMicros ?? 0)}</li>
                <li>
                  The same screening at the large model's observed rate:{" "}
                  {formatMicros(report.counterfactualMicros)}
                </li>
                <li>
                  Difference: {formatMicros(report.savedMicros ?? 0)}
                  {report.savedMultiple ? ` (${report.savedMultiple.toFixed(1)}x)` : ""}
                </li>
                <li>
                  Total actually spent, every tier included: {formatMicros(report.spentMicros)}
                </li>
              </ul>

              <p style={{ color: "#555" }}>
                How that is calculated, so it can be argued with. The tokens the screening pass
                actually used are repriced at the cost per token the large model actually charged,
                both taken from the table above. It is deliberately not an average cost per call:
                the large model answers adjudications and reconsiderations, and a reconsideration
                carries the person's explanation and is a longer prompt, so a per-call average would
                inherit that length and overstate the saving.
              </p>
              <p style={{ color: "#555" }}>
                What it assumes is that the large model, given the same prompt, would have written a
                similar-length answer. That is an assumption and not something this ledger can show.
                The escalation spending is left out of the comparison on purpose, because those
                calls happen either way.
              </p>
            </>
          )}
        </>
      )}

      <p style={{ borderTop: "1px solid #ddd", paddingTop: "1rem", marginTop: "1.5rem" }}>
        <Link to="/">Back to Bucket</Link>
      </p>
    </main>
  );
}
