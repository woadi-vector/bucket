#!/usr/bin/env node
/**
 * Price extraction checks. Bundles src/engine/pricing.ts and runs it against fixed snippets.
 *
 * This is the module that puts a dollar figure in front of someone about their own money, so
 * the cases that matter most here are the ones where it must refuse. A missed saving is a tip
 * the person could have found themselves. A wrong one is the app confidently inventing money,
 * which is the failure that would discredit every other number it reports.
 *
 *   npm run check:pricing
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-pricing: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/engine/pricing.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-pricing-"));
const file = join(dir, "pricing.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { findCheaperOption, describeFinding } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

/** Evidence shaped the way the engine hands it over. */
const ev = (items, summary) => ({
  query: "Arctis Nova Pro repair cost vs replacement",
  provider: "tavily",
  items: items.map((i) => ({
    title: i.title ?? "A page",
    url: i.url ?? "https://x.test/a",
    snippet: i.snippet ?? "",
  })),
  ...(summary ? { summary } : {}),
});

// 1. The case this was built for: a replacement part, priced, against a $280 headset.
{
  const f = findCheaperOption(
    ev([
      {
        title: "Arctis Nova Pro earpad kit",
        snippet: "Replacement memory foam earpads, $49.99, ships free.",
        url: "https://parts.test/pads",
      },
    ]),
    280,
  );
  check("found: a cheaper part is picked up", f !== null);
  check("found: amount read from the snippet", f.amount === 49.99, `${f.amount}`);
  check("found: the subtraction happens here", f.saving === 280 - 49.99, `${f.saving}`);
  check("found: compared against the purchase", f.against === 280);
  check("found: carries the page it came from", f.source.url === "https://parts.test/pads");
  check(
    "found: the sentence states both numbers and the source",
    describeFinding(f).includes("$49.99") &&
      describeFinding(f).includes("$230.01") &&
      describeFinding(f).includes("earpad kit"),
    describeFinding(f),
  );
}

// 2. Nothing is claimed when nothing is cheap enough to change a decision.
{
  check(
    "refuses: a saving under the dollar floor",
    findCheaperOption(ev([{ snippet: "Protective case, $270." }]), 280) === null,
  );
  check(
    "refuses: a saving under the share floor",
    findCheaperOption(ev([{ snippet: "Refurbished unit, $215." }]), 280) === null,
    "215 of 280 is a 23% saving",
  );
  check(
    "refuses: an option that costs more than the purchase",
    findCheaperOption(ev([{ snippet: "The newer model is $399." }]), 280) === null,
  );
  check(
    "refuses: something too cheap to be the fix",
    findCheaperOption(ev([{ snippet: "Cable clip, $3." }]), 280) === null,
  );
}

// 3. Numbers that are not prices. Every one of these produced a wrong claim in an earlier
//    draft that matched bare digits, which is why the currency marker is mandatory.
{
  check(
    "noise: a model number is not a price",
    findCheaperOption(ev([{ snippet: "The Nova Pro 7P and 2024 revision both fit." }]), 280) ===
      null,
  );
  check(
    "noise: a percentage is not a price",
    findCheaperOption(ev([{ snippet: "Rated 95 out of 100 by 4200 reviewers." }]), 280) === null,
  );
  check(
    "noise: a listicle threshold is not what you would pay",
    findCheaperOption(ev([{ title: "10 best headsets under 100" }]), 280) === null,
  );
}

// 4. The pre-discount price is not the price. A page that says "was $280, now $45" must not
//    be read as a $280 option, and must still find the $45 one.
{
  const f = findCheaperOption(ev([{ snippet: "Pad kit, was $120, now $45." }]), 280);
  check("stale: the current price wins", f !== null && f.amount === 45, `${f?.amount}`);

  check(
    "stale: an original price alone is not an option",
    findCheaperOption(ev([{ snippet: "Originally $90 at launch." }]), 280) === null,
    "no current price on the page",
  );
  check(
    "stale: a marketing saving is not a price",
    findCheaperOption(ev([{ snippet: "Save $200 on select models." }]), 280) === null,
  );
}

// 5. The provider's own summary is never read. A number there cannot be attributed to a page
//    the person can open, and an unattributable figure is the thing this module exists to
//    keep out of the app.
{
  check(
    "summary: a price in the provider's prose is ignored",
    findCheaperOption(ev([], "Replacement pads are widely available for about $40."), 280) === null,
  );
  const f = findCheaperOption(
    ev(
      [{ snippet: "Pad kit, $52.", url: "https://parts.test/kit" }],
      "Pads go for around $12 somewhere.",
    ),
    280,
  );
  check("summary: the item is used instead", f !== null && f.amount === 52, `${f?.amount}`);
}

// 6. The lowest credible option across several pages, attributed to the right one.
{
  const f = findCheaperOption(
    ev([
      { title: "Official pads", snippet: "$89.00", url: "https://a.test" },
      { title: "Third-party pads", snippet: "$39.95", url: "https://b.test" },
      { title: "Repair service", snippet: "$120", url: "https://c.test" },
    ]),
    280,
  );
  check("lowest: picks the cheapest", f.amount === 39.95, `${f.amount}`);
  check("lowest: attributes it to that page", f.source.url === "https://b.test", f.source.url);
}

// 7. Formats that appear on real pages.
{
  check(
    "format: thousands separator",
    findCheaperOption(ev([{ snippet: "Open-box, $1,199.00" }]), 2400)?.amount === 1199,
  );
  check(
    "format: a space after the sign",
    findCheaperOption(ev([{ snippet: "Kit is $ 45 shipped" }]), 280)?.amount === 45,
  );
  check(
    "format: whole dollars",
    findCheaperOption(ev([{ snippet: "Pads $60" }]), 280)?.amount === 60,
  );
}

// 8. Currencies that are not dollars are left alone rather than subtracted from a dollar
//    amount, which would produce a confident wrong number.
{
  check(
    "currency: euros are not read as dollars",
    findCheaperOption(ev([{ snippet: "Ersatz-Ohrpolster, 45€" }]), 280) === null,
  );
  check(
    "currency: pounds are not read as dollars",
    findCheaperOption(ev([{ snippet: "Earpads £38 delivered" }]), 280) === null,
  );
}

// 9. Nonsense in, nothing out.
{
  check("empty: no items", findCheaperOption(ev([]), 280) === null);
  check("empty: no purchase amount", findCheaperOption(ev([{ snippet: "$10" }]), 0) === null);
  check(
    "empty: a negative purchase amount",
    findCheaperOption(ev([{ snippet: "$10" }]), -5) === null,
  );
}

// 10. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
