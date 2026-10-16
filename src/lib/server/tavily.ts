import { shapeEvidence, type Evidence, type EvidenceSource } from "@/engine";

/**
 * Tavily, behind the engine's {@link EvidenceSource} hook.
 *
 * The engine decides what to look up and how much weight to give the answer. This file does
 * one thing: make the HTTP call and turn the response into the engine's shape. It holds the
 * key, same as the model adapter holds the Token Factory key, and like that adapter it must
 * never be imported from a component.
 *
 * Everything here fails soft. A null return means "no evidence", which the engine treats as
 * identical to having no search configured at all. That is deliberate: a third party being
 * down, slow, rate-limited or differently-shaped than documented must not change what Bucket
 * tells somebody about their own money.
 */

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/**
 * Hard ceiling on how long a verdict waits for a search.
 *
 * Someone is sitting in front of the app having just typed an explanation. Four seconds is
 * already a long time to hold them; past that the search is worth less than the delay, so it
 * is abandoned and the model answers without it.
 */
const TIMEOUT_MS = 4000;

/** What we ask for. `basic` depth and three results: enough to be useful, cheap in credits. */
const SEARCH_DEPTH = "basic";
const MAX_RESULTS = 3;

type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

type TavilyResponse = {
  answer?: unknown;
  results?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function createTavilySource(opts: { apiKey: string }): EvidenceSource {
  return {
    name: "tavily",

    async search(query: string): Promise<Evidence | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            search_depth: SEARCH_DEPTH,
            max_results: MAX_RESULTS,
            // A one-line synthesis is usually more use to the model than three snippets, and
            // it is what makes a finding quotable back to the person.
            include_answer: "basic",
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Read a little of the body: Tavily's 4xx messages name the offending parameter,
          // which is the difference between "my key is wrong" and "my request is wrong".
          const detail = await response.text().catch(() => "");
          console.warn(
            `[tavily] search declined (${response.status}); deciding without evidence`,
            detail.slice(0, 300),
          );
          return null;
        }

        const body = (await response.json()) as TavilyResponse;
        const rawResults = Array.isArray(body.results) ? body.results : [];

        // The engine caps and trims. This only has to get the field names right, and to
        // tolerate any of them being absent, because a schema change should degrade to no
        // evidence rather than to a crash mid-verdict.
        return shapeEvidence({
          query,
          provider: "tavily",
          summary: str(body.answer) || undefined,
          items: rawResults.map((r) => {
            const item = r as TavilyResult;
            return {
              title: str(item.title),
              url: str(item.url),
              snippet: str(item.content),
            };
          }),
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        console.warn(
          aborted
            ? `[tavily] search exceeded ${TIMEOUT_MS}ms; deciding without evidence`
            : "[tavily] search failed; deciding without evidence",
          aborted ? "" : error,
        );
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
