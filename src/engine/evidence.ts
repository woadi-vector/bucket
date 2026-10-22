import type { PurchaseUnderReview } from "./types";
import { describeFinding, type PriceFinding } from "./pricing";

/**
 * Looking things up in the world before deciding.
 *
 * The weakest moment in Bucket is the one where someone says "the old one broke, I need this."
 * Nothing in a model's weights knows whether that particular thing can be fixed for a tenth of
 * the price. A live lookup is the only way to find out, and finding out is the most useful
 * thing the app can do at that exact moment.
 *
 * Two rules shape everything here, and both are about not making the app worse:
 *
 * A lookup can only ever ADD a fact. No evidence, a failed search, an empty result and a
 * timeout are all the same thing: the verdict is decided the way it was before this file
 * existed. Nothing degrades into a harsher answer because a third party was slow.
 *
 * And a found alternative is not a verdict. "There is a $40 repair kit" is worth saying out
 * loud; it is not proof that the purchase is a want. People have reasons to decline repairs,
 * and the model is told as much.
 */

/** One thing the search turned up. Deliberately small: a title, a link, a snippet. */
export type EvidenceItem = {
  title: string;
  url: string;
  snippet: string;
};

export type Evidence = {
  /** The query that was actually sent, stored so a reader can judge whether it was fair. */
  query: string;
  /** The provider's own one-line summary, when it offered one. */
  summary?: string;
  items: EvidenceItem[];
  /** Which service answered, for the ledger. */
  provider: string;
};

/**
 * Supplied by the caller, same as the model adapter. The engine decides what to look up; the
 * server owns the credentials and the network.
 *
 * Must never throw: a rejected promise is caught by the engine and treated as no evidence, but
 * implementations should prefer returning null so the reason gets logged where it happened.
 */
export type EvidenceSource = {
  name: string;
  search(query: string): Promise<Evidence | null>;
};

/**
 * Words that suggest the person is replacing something that failed, rather than buying
 * something new. Crude on purpose: see {@link buildEvidenceQuery} for why this is a keyword
 * test and not a model call.
 */
const BREAKAGE =
  /\b(broke|broken|breaking|died|dead|cracked|torn|ripped|stopped working|quit working|no longer works|not working|failed|worn out|frayed)\b/i;

/**
 * Builds the query, from the purchase label and nothing else.
 *
 * The explanation the person typed is NOT sent. It is the most personal text in the app, it is
 * free-form, and it is exactly the kind of thing that should not be handed to a third-party
 * search API because it might make a better query. Only two bits leave: the label they already
 * typed as the name of a purchase, and a single yes/no read on whether their explanation
 * mentions something failing.
 *
 * That yes/no is a keyword test rather than a model call for the same reason. Classifying the
 * explanation properly would mean sending it somewhere, which is the thing being avoided. The
 * cost is that an unusual phrasing picks the broader query, which is a worse search and not a
 * leak.
 */
export function buildEvidenceQuery(
  purchase: PurchaseUnderReview,
  explanation: string,
): string | null {
  const label = purchase.label
    // Scenario markers are a development affordance and have no business in a search query.
    .replace(/#\w+/g, "")
    .trim()
    .slice(0, 80);

  // Nothing useful to search for. Better no evidence than a query for "".
  if (label.length < 3) return null;

  return BREAKAGE.test(explanation)
    ? `${label} repair cost vs replacement`
    : `${label} cheaper alternatives typical price`;
}

/** Caps, so a chatty provider cannot inflate the prompt or the cost of a verdict. */
const MAX_ITEMS = 3;
const MAX_SNIPPET = 300;
const MAX_SUMMARY = 400;

/**
 * Reduces a URL to something comparable, for spotting the same page twice.
 *
 * Drops the scheme, a leading `www.`, the query string, the fragment and a trailing slash.
 * Dropping the whole query is heavy-handed and will occasionally merge two genuinely
 * different pages that differ only by a parameter. That is the right way to be wrong here:
 * losing one result costs a line of a prompt, while counting one source twice distorts what
 * the model thinks it knows.
 *
 * Falls back to the raw string for anything unparseable rather than throwing, since a
 * malformed URL from a provider must not take down a verdict.
 */
function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Trims a provider's response to what a prompt should carry. */
export function shapeEvidence(args: {
  query: string;
  provider: string;
  summary?: string;
  items: EvidenceItem[];
}): Evidence | null {
  // Deduplicate before capping. Providers return the same page under several URLs (a bare
  // one and the same one with tracking parameters), which was observed against the real API
  // on the first probe: two of three slots went to one article. Left in, a single source
  // appears to the model as two sources agreeing, which is worse than having one fewer.
  const seen = new Set<string>();
  const items = args.items
    .filter((i) => i.title.trim() && i.url.trim())
    .filter((i) => {
      const key = canonicalUrl(i.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ITEMS)
    .map((i) => ({
      title: i.title.trim().slice(0, 160),
      url: i.url.trim().slice(0, 300),
      snippet: i.snippet.trim().slice(0, MAX_SNIPPET),
    }));

  const summary = args.summary?.trim().slice(0, MAX_SUMMARY);

  // A result with neither a summary nor a usable item is not evidence of anything.
  if (!summary && items.length === 0) return null;

  return {
    query: args.query,
    ...(summary ? { summary } : {}),
    items,
    provider: args.provider,
  };
}

/**
 * Renders evidence for the prompt, with the instructions on how to weigh it attached.
 *
 * The instructions live next to the evidence rather than in the system prompt because they are
 * only true when there is evidence, and a model reading standing rules about search results
 * that are not present tends to invent some.
 */
export function describeEvidence(evidence: Evidence, finding?: PriceFinding): string {
  const lines = [
    "You also looked something up. This is what came back:",
    "",
    `Searched: ${evidence.query}`,
  ];

  if (evidence.summary) lines.push(`Summary: ${evidence.summary}`);

  for (const item of evidence.items) {
    lines.push(`- ${item.title}${item.snippet ? `: ${item.snippet}` : ""}`);
  }

  if (finding) {
    lines.push("", describeFinding(finding));
  }

  lines.push(
    "",
    "How to use that. If it shows a cheaper way to solve the problem the person described, say",
    "so plainly, because that is useful to them whatever you decide. But a cheaper option",
    "existing does not settle the question: people decline repairs for reasons that are none of",
    "your business, and a search result can be wrong, stale, or about a different model of the",
    "thing. If the results do not bear on what they told you, ignore them and do not mention",
    "them. Finding nothing is not evidence that nothing exists, so never treat an empty or",
    "unhelpful search as a point against the person.",
  );

  // The one hard rule about money. Figures reach the person from the line above, which was
  // computed from the purchase amount and a price read out of a named page, or they do not
  // reach the person at all.
  lines.push(
    "",
    finding
      ? "About the figures. The comparison above was worked out by the app, from a price on a page" +
          " it can name. Use those exact numbers or none: do not round them, recompute them, add" +
          " shipping, or estimate anything beside them. You may say what the cheaper option is and" +
          " whether it fits what they described."
      : "About the figures. No price comparison was worked out here, so state no dollar amount of" +
          " any kind. Do not read a number out of a result and do not estimate one. You can say an" +
          " option appears to exist without pricing it.",
  );

  return lines.join("\n");
}
