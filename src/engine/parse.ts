import type { Intent, Verdict } from "./types";

export class VerdictParseError extends Error {
  constructor(
    message: string,
    readonly text: string,
  ) {
    super(message);
    this.name = "VerdictParseError";
  }
}

/**
 * Pulls every balanced `{...}` span out of a string, outermost first.
 *
 * Reasoning models wrap their answer in prose or a code fence even when asked not to, and
 * `response_format` is not guaranteed to be honoured. Two things follow, both of which
 * cost real debugging time if ignored:
 *
 *   - a regex is not enough, because the reasoning text usually contains braces of its own
 *     and a greedy or lazy match picks the wrong span; and
 *   - the *first* balanced span is often not the answer. A trace like
 *     "the user said {need} but their history {shows}..." yields two junk spans before the
 *     real object, so the caller must be able to try each in turn.
 */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return candidates;
}

const asIntent = (v: unknown): Intent | null =>
  v === "want" || v === "need"
    ? v
    : typeof v === "string" && v.trim().toLowerCase() === "want"
      ? "want"
      : typeof v === "string" && v.trim().toLowerCase() === "need"
        ? "need"
        : null;

const clampConfidence = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  // Models sometimes answer on a 0-100 scale despite being asked for 0-1.
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
};

/**
 * Turns raw model text into a {@link Verdict}.
 *
 * `agrees` is derived by comparing the verdict to the user's tag rather than read from the
 * response. Asking a model to restate a boolean it could have computed is a reliable way to
 * get an inconsistent one, and `agrees` is what drives whether the app escalates.
 */
export function parseVerdict(text: string, userIntent: Intent): Omit<Verdict, "telemetry"> {
  const candidates = extractJsonCandidates(text);
  if (candidates.length === 0) {
    throw new VerdictParseError("No JSON object found in model output", text);
  }

  // Take the first span that both parses and carries a usable verdict. Earlier spans are
  // usually braces that appeared inside the reasoning trace.
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

    const obj = parsed as Record<string, unknown>;
    const verdict = asIntent(obj.verdict);
    if (!verdict) continue;

    return {
      agrees: verdict === userIntent,
      verdict,
      confidence: clampConfidence(obj.confidence),
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning.trim() : "",
    };
  }

  throw new VerdictParseError("No JSON object in the output carried a usable verdict", text);
}
