#!/usr/bin/env node
/**
 * Calls Tavily once, for real, and prints what came back.
 *
 * This exists because the rest of the Tavily code is built to fail soft: a wrong key, a
 * renamed parameter or a changed response shape all degrade silently to "no evidence", which
 * is right for someone using the app and useless for finding out whether the integration
 * works. This script is the opposite. It is loud, it does not catch anything, and a non-200
 * prints the body so the message naming the bad parameter is visible.
 *
 *   node scripts/probe-tavily.mjs
 *   node scripts/probe-tavily.mjs "sony wh-1000xm4 earpad replacement cost"
 *
 * Reads TAVILY_API_KEY from the environment, or from .dev.vars if it is not set. Costs one
 * Tavily credit per run.
 */

import { readFileSync } from "node:fs";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

function readKey() {
  if (process.env.TAVILY_API_KEY?.trim()) return process.env.TAVILY_API_KEY.trim();
  try {
    const line = readFileSync(".dev.vars", "utf8")
      .split("\n")
      .find((l) => /^\s*TAVILY_API_KEY\s*=/.test(l));
    const value = line
      ?.split("=")
      .slice(1)
      .join("=")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value) return value;
  } catch {
    // No .dev.vars is not an error; the message below covers both cases.
  }
  console.error(
    "TAVILY_API_KEY is not set. Put it in .dev.vars (see .dev.vars.example) or export it.",
  );
  process.exit(1);
}

const query = process.argv[2] ?? "Headphones repair cost vs replacement";
const key = readKey();

console.log(`POST ${TAVILY_SEARCH_URL}`);
console.log(`query: ${query}\n`);

const started = Date.now();
const response = await fetch(TAVILY_SEARCH_URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    query,
    search_depth: "basic",
    max_results: 3,
    include_answer: "basic",
  }),
});

const elapsed = Date.now() - started;
console.log(`HTTP ${response.status} in ${elapsed}ms\n`);

if (!response.ok) {
  // The 4xx body is the whole point of running this: it names the offending parameter.
  console.error(await response.text());
  process.exit(1);
}

const body = await response.json();

console.log("answer:", body.answer ?? "(none returned)");
console.log(`\nresults: ${Array.isArray(body.results) ? body.results.length : 0}`);
for (const r of body.results ?? []) {
  console.log(`\n  ${r.title}`);
  console.log(`  ${r.url}`);
  console.log(`  ${String(r.content ?? "").slice(0, 200)}`);
}

// The fields the app actually reads. If any of these are missing the integration degrades to
// no evidence without saying so, so they are checked here explicitly.
const first = (body.results ?? [])[0];
const missing = [
  typeof body.answer === "string" ? null : "answer",
  first && typeof first.title === "string" ? null : "results[0].title",
  first && typeof first.url === "string" ? null : "results[0].url",
  first && typeof first.content === "string" ? null : "results[0].content",
].filter(Boolean);

console.log(
  missing.length === 0
    ? "\nEvery field the app reads is present."
    : `\nFIELDS THE APP READS BUT DID NOT GET: ${missing.join(", ")}\n` +
        "The app would still work and simply decide without evidence, so this is worth fixing.",
);
