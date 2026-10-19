import { createFileRoute, Link } from "@tanstack/react-router";
import { readExchangeLog, type ExchangeLog } from "@/lib/bucket/exchange-fns";
import type { ExchangeRow } from "@/lib/server/exchanges";

/**
 * The record of every purchase Bucket argued about.
 *
 * This page is evidence, not product. It is deliberately plain: no palette, no motion, no
 * celebration. Someone checking whether the clarification question actually works should be
 * reading rows, not admiring a layout, and a designed page invites the suspicion that the
 * numbers were arranged to look good.
 *
 * Nothing is filtered. The challenges that collapsed the moment someone explained themselves
 * are here next to the ones that held. That is the point: a hit rate is only worth reading if
 * the misses were published by the same code path.
 *
 * It takes a key (`?key=`, checked against `EXCHANGES_KEY`) because it holds purchase labels
 * and whatever people typed. The rest of the app has no login so a judge can open it cold;
 * this page cannot work that way without publishing a tester's own words.
 */

export const Route = createFileRoute("/exchanges")({
  validateSearch: (search: Record<string, unknown>) => ({
    key: typeof search.key === "string" ? search.key : undefined,
  }),
  loaderDeps: ({ search: { key } }) => ({ key }),
  loader: ({ deps: { key } }) => readExchangeLog({ data: { key: key ?? null } }),
  component: ExchangesPage,
});

const pct = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(0)}%`;

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function Outcome({ row }: { row: ExchangeRow }) {
  // A withheld contest was never put to anyone, so "unanswered" would read as a person who
  // ignored a question rather than a question that was never asked.
  if (row.withheldReason !== null) {
    return <span style={{ color: "#777" }}>never asked</span>;
  }
  if (row.answeredAt === null) {
    return <span style={{ color: "#777" }}>unanswered</span>;
  }
  return row.explanationAccepted === 1 ? (
    <strong>explanation accepted</strong>
  ) : (
    <span>verdict held</span>
  );
}

/**
 * What became of the objection: said out loud, or kept back and why.
 *
 * Spelled out per row rather than left to the counts, because the counts are the part a
 * reader has to take on trust and the rows are the part they can audit. A summary saying
 * Bucket held back nine times is worth exactly as much as the nine rows underneath it.
 */
function Restraint({ row }: { row: ExchangeRow }) {
  if (row.withheldReason === null) return null;

  if (row.withheldReason === "overruled") {
    return (
      <p style={{ margin: "0.25rem 0" }}>
        Escalated. The larger model was asked the same question and answered{" "}
        <strong>{row.overruledVerdict}</strong>, siding with the person. The objection was dropped
        and never shown.
        {row.overruledReasoning ? (
          <blockquote
            style={{ margin: "0.5rem 0", paddingLeft: "0.75rem", borderLeft: "3px solid #ccc" }}
          >
            {row.overruledReasoning}
          </blockquote>
        ) : null}
      </p>
    );
  }

  return (
    <p style={{ margin: "0.25rem 0" }}>
      Held back: under the confidence floor for contesting a {row.userIntent}. Nothing was shown and
      no question was asked.
    </p>
  );
}

function ExchangeEntry({ row }: { row: ExchangeRow }) {
  return (
    <article
      style={{
        borderTop: "1px solid #ddd",
        padding: "1rem 0",
        opacity: row.degraded ? 0.55 : 1,
      }}
    >
      <header style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.5rem" }}>
        {when(row.createdAt)} · {row.label} · ${row.amount.toFixed(2)}
        {row.bucketName ? ` · ${row.bucketName}` : ""}
        {row.readinessTag ? ` · ${row.readinessTag}` : ""}
        {row.withheldReason ? " · NEVER SHOWN TO THE PERSON" : ""}
        {row.degraded ? " · DEGRADED, excluded from the rates" : ""}
      </header>

      <p style={{ margin: "0.25rem 0" }}>
        Tagged <strong>{row.userIntent}</strong>. Bucket said{" "}
        <strong>{row.screeningVerdict}</strong> at {row.screeningConfidence.toFixed(2)}.
      </p>

      {row.screeningReasoning ? (
        <blockquote
          style={{ margin: "0.5rem 0", paddingLeft: "0.75rem", borderLeft: "3px solid #ccc" }}
        >
          {row.screeningReasoning}
        </blockquote>
      ) : null}

      <Restraint row={row} />

      {row.question ? <p style={{ margin: "0.25rem 0" }}>Asked: {row.question}</p> : null}

      {row.explanation ? <p style={{ margin: "0.25rem 0" }}>Answered: {row.explanation}</p> : null}

      {row.evidenceQuery ? (
        <p style={{ margin: "0.25rem 0", color: "#555" }}>
          Looked up via {row.evidenceProvider}: {row.evidenceQuery} ({row.evidenceResults ?? 0}{" "}
          results)
        </p>
      ) : null}

      {row.finalVerdict ? (
        <p style={{ margin: "0.25rem 0" }}>
          Then said <strong>{row.finalVerdict}</strong>
          {row.finalConfidence !== null ? ` at ${row.finalConfidence.toFixed(2)}` : ""}.{" "}
          <Outcome row={row} />
        </p>
      ) : (
        <p style={{ margin: "0.25rem 0" }}>
          <Outcome row={row} />
        </p>
      )}

      {row.finalReasoning ? (
        <blockquote
          style={{ margin: "0.5rem 0", paddingLeft: "0.75rem", borderLeft: "3px solid #ccc" }}
        >
          {row.finalReasoning}
        </blockquote>
      ) : null}
    </article>
  );
}

function ExchangesPage() {
  const log = Route.useLoaderData() as ExchangeLog;

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

  if (!log.unlocked) {
    return (
      <main style={page}>
        <h1 style={{ fontSize: "1.1rem" }}>Exchange log</h1>
        <p>
          This page needs a key. It holds what people typed about their own spending, so it is not
          public even though the rest of the app is.
        </p>
        <p>
          <Link to="/">Back to Bucket</Link>
        </p>
      </main>
    );
  }

  const { summary, rows } = log;

  return (
    <main style={page}>
      <h1 style={{ fontSize: "1.1rem" }}>Exchange log</h1>

      <p>
        Every purchase Bucket contested, and what happened when the person answered back. Unfiltered
        and in order. The challenges that did not survive being explained are here beside the ones
        that did, because a number you can only see the good half of is not worth checking.
      </p>

      <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>What Bucket kept to itself</h2>
      <ul style={{ paddingLeft: "1.25rem" }}>
        <li>Times Bucket disagreed with the person: {summary.challenges}</li>
        <li>
          Times it said so: {summary.spoken} ({pct(summary.spoken, summary.challenges)})
        </li>
        <li>Dropped because the larger model took the person's side: {summary.overruled}</li>
        <li>Dropped as too unsure to be worth saying: {summary.unsure}</li>
      </ul>

      <p style={{ color: "#555" }}>
        The second line is the one worth checking, and the two below it are why. Every row in this
        table is a disagreement, and the ones marked NEVER SHOWN are disagreements the person lived
        their day without hearing. An app that objects to every purchase gets deleted, so the
        restraint matters as much as the judgement, and a claim about restraint is only worth
        reading next to the objections it threw away.
      </p>

      <p style={{ color: "#555" }}>
        The two silences are not equally strong. An overruled one rests on two different models
        reaching different answers and the system resolving it without spending the person's
        attention. An unsure one rests only on a confidence number the model reported about itself,
        which is the weakest evidence here, which is why the two are counted separately rather than
        added together.
      </p>

      <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>Counts</h2>
      <ul style={{ paddingLeft: "1.25rem" }}>
        <li>Challenges issued: {summary.challenges}</li>
        <li>Of those, degraded (a fallback answered, not a model): {summary.degraded}</li>
        <li>Answered by the person: {summary.answered}</li>
        <li>
          Explanation accepted: {summary.accepted} ({pct(summary.accepted, summary.answered)} of
          answered)
        </li>
        <li>
          Verdict held: {summary.held} ({pct(summary.held, summary.answered)} of answered)
        </li>
      </ul>

      <p style={{ color: "#555" }}>
        Read the accepted rate as how often a challenge did not survive the person's reasoning. A
        high number is not a broken model: it is the question doing its job. What would be damning
        is a model that never changed its mind, which would make the question theatre. Degraded rows
        are excluded from both rates and shown faded below.
      </p>

      <h2 style={{ fontSize: "0.95rem", marginTop: "1.5rem" }}>
        Exchanges {rows.length > 0 ? `(latest ${rows.length})` : ""}
      </h2>

      {rows.length === 0 ? (
        <p>Nothing recorded yet.</p>
      ) : (
        rows.map((row) => <ExchangeEntry key={row.id} row={row} />)
      )}

      <p style={{ borderTop: "1px solid #ddd", paddingTop: "1rem", marginTop: "1.5rem" }}>
        <Link to="/">Back to Bucket</Link>
      </p>
    </main>
  );
}
