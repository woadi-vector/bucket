#!/usr/bin/env node
/**
 * Payments checks. Bundles src/lib/server/payments.ts and runs it against a fake PayPal.
 *
 * Every claim the PayPal video makes about money is checked here: a need captures with no
 * pause, a held want can be kept or let go exactly once, the clock voids what nobody decided,
 * and no model can reach a capture or a void. If the video says it, this file tests it.
 *
 * The fake answers the same endpoints, with the same shapes, that the real sandbox answered
 * when each call was run by hand on Oct 18 2026. For a run against the real sandbox, see
 * scripts/probe-paypal.mjs.
 *
 *   npm run check:payments
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

// --- 1. The money boundary --------------------------------------------------------------------
//
// payments.ts must not import anything from the engine, directly or through another module.
// The metafile lists every source file the bundle pulled in, so this catches indirect imports
// too. And the engine must not import payments or the PayPal client.

const bundled = await build({
  entryPoints: ["src/lib/server/payments.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  metafile: true,
  logLevel: "error",
  alias: { "@": resolve("src") },
});

const inputs = Object.keys(bundled.metafile.inputs);
const engineInputs = inputs.filter(
  (p) => /src\/engine\//.test(p) || /token-factory|verdict/.test(p),
);
check(
  "payments.ts pulls in nothing from the engine",
  engineInputs.length === 0,
  engineInputs.join(", "),
);

const engineDir = resolve("src/engine");
const engineFiles = readdirSync(engineDir).filter((f) => f.endsWith(".ts"));
const leaks = engineFiles.filter((f) =>
  /server\/(payments|paypal|holds)/.test(readFileSync(join(engineDir, f), "utf8")),
);
check("no engine file imports payments, paypal, or holds", leaks.length === 0, leaks.join(", "));

const exportedNames = Object.keys(await importBundle(bundled));
check(
  "payments exports no tool definitions",
  !exportedNames.some((n) => /tool/i.test(n)),
  exportedNames.join(", "),
);

// --- 2. A fake PayPal -------------------------------------------------------------------------

const fake = {
  tokenRequests: 0,
  calls: [],
  auths: new Map(), // authorizationId -> { status }
  seenRequestIds: new Map(), // PayPal-Request-Id -> response, for idempotency
  // Failure switches, reset per test.
  captureFailsAfterApplying: false, // capture succeeds at PayPal but the response is a 500
  voidFailsHard: false, // void rejected, nothing applied
  statusUnreachable: false,
};
let nextId = 1;
const newId = (prefix) => `${prefix}${String(nextId++).padStart(6, "0")}`;

const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  const headers = init.headers ?? {};
  fake.calls.push(`${method} ${u.pathname}`);

  if (u.host !== "api-m.sandbox.paypal.com") {
    throw new Error(`check-payments: unexpected host ${u.host}`);
  }

  if (u.pathname === "/v1/oauth2/token") {
    fake.tokenRequests++;
    return json(200, { access_token: "fake-token", expires_in: 32400, scope: "" });
  }
  if (headers.Authorization !== "Bearer fake-token")
    return json(401, { name: "AUTHENTICATION_FAILURE" });

  const requestId = headers["PayPal-Request-Id"];
  const replay = requestId && fake.seenRequestIds.get(requestId);
  if (replay) return json(replay.status, replay.body);
  const remember = (status, body) => {
    if (requestId) fake.seenRequestIds.set(requestId, { status, body });
    return json(status, body);
  };

  if (method === "POST" && u.pathname === "/v2/checkout/orders") {
    const body = JSON.parse(init.body);
    if (!requestId)
      return json(400, { name: "INVALID_REQUEST", message: "PayPal-Request-Id required" });
    if (!body.payment_source?.paypal?.vault_id) return json(400, { name: "INVALID_REQUEST" });
    const unit = body.purchase_units[0];
    const authId = newId("AUTH");
    fake.auths.set(authId, { status: "CREATED" });
    return remember(201, {
      id: newId("ORDER"),
      status: "COMPLETED",
      purchase_units: [
        {
          custom_id: headers.Prefer === "return=representation" ? unit.custom_id : undefined,
          payments: {
            authorizations: [
              { id: authId, status: "CREATED", expiration_time: "2026-11-16T13:40:05Z" },
            ],
          },
        },
      ],
    });
  }

  const m = u.pathname.match(/^\/v2\/payments\/authorizations\/([^/]+)(?:\/(capture|void))?$/);
  if (m) {
    const auth = fake.auths.get(m[1]);
    if (!auth) return json(404, { name: "RESOURCE_NOT_FOUND" });
    const action = m[2];
    if (!action) {
      if (fake.statusUnreachable) return json(503, {});
      return json(200, { id: m[1], status: auth.status });
    }
    if (auth.status !== "CREATED") {
      return remember(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: `AUTHORIZATION_ALREADY_${auth.status}` }],
      });
    }
    if (action === "capture") {
      auth.status = "CAPTURED";
      if (fake.captureFailsAfterApplying) return json(500, { name: "INTERNAL_SERVER_ERROR" });
      return remember(201, { id: newId("CAP"), status: "COMPLETED" });
    }
    if (fake.voidFailsHard) return json(500, { name: "INTERNAL_SERVER_ERROR" });
    auth.status = "VOIDED";
    return remember(204, undefined);
  }

  return json(404, { name: "RESOURCE_NOT_FOUND" });
};

process.env.PAYPAL_CLIENT_ID = "fake-client";
process.env.PAYPAL_CLIENT_SECRET = "fake-secret";

const payments = await importBundle(bundled);
const holds = await importBundle(
  await build({
    entryPoints: ["src/lib/server/holds.ts"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    logLevel: "error",
    alias: { "@": resolve("src") },
  }),
);

const reset = () => {
  globalThis.__bucketHolds?.clear();
  fake.calls = [];
  fake.captureFailsAfterApplying = false;
  fake.voidFailsHard = false;
  fake.statusUnreachable = false;
};

const base = {
  sessionId: "session-a",
  label: "Running shoes",
  merchant: "Demo store",
  amountCents: 2499,
  vaultId: "vault-123",
};
const count = (prefix) => fake.calls.filter((c) => c.startsWith(prefix)).length;

// --- 3. Behavior --------------------------------------------------------------------------

// A need passes straight through to capture.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-groceries",
    bucketTag: "need",
    verdict: "pass",
  });
  check(
    "a need captures with no pause",
    hold.state === "captured" && hold.decidedBy === "policy",
    hold.state,
  );
  check(
    "the capture id is recorded",
    typeof hold.captureId === "string" && hold.captureId.length > 0,
  );
}

// A want is held, with the bucket stamped on PayPal's record.
reset();
let wantId;
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  wantId = hold.id;
  check(
    "a want is held, not captured",
    hold.state === "held" && count("POST /v2/payments") === 0,
    hold.state,
  );
  check("the hold carries PayPal's authorization id", /^AUTH/.test(hold.authorizationId));
  const window = hold.deadlineAt - hold.createdAt;
  check(
    "the default hold window is 24 hours",
    window === 24 * 60 * 60_000,
    `${window / 60_000} minutes`,
  );
}

// Letting it go voids it, exactly once.
{
  const result = await payments.letGo(wantId, { decidedBy: "user", sessionId: "session-a" });
  check(
    "letting a want go voids it",
    result.ok && result.hold.state === "voided",
    result.ok ? result.hold.state : result.reason,
  );
  const again = await payments.letGo(wantId, { decidedBy: "user", sessionId: "session-a" });
  check("a second let-go is refused", !again.ok && again.reason === "not-held");
  const keepAfter = await payments.keep(wantId, { decidedBy: "user", sessionId: "session-a" });
  check("keeping a voided hold is refused", !keepAfter.ok && keepAfter.reason === "not-held");
  check(
    "exactly one void reached PayPal",
    count("POST /v2/payments") === 1,
    fake.calls.join(" | "),
  );
}

// Keeping a held want captures it; a void afterwards never reaches PayPal.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  const kept = await payments.keep(hold.id, { decidedBy: "user", sessionId: "session-a" });
  check("keeping a want captures it", kept.ok && kept.hold.state === "captured");
  const voidAfter = await payments.letGo(hold.id, { decidedBy: "user", sessionId: "session-a" });
  check(
    "letting go after a capture is refused without calling PayPal",
    !voidAfter.ok && count("POST /v2/payments") === 1,
  );
}

// Another visitor cannot act on this hold.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  const stranger = await payments.letGo(hold.id, { decidedBy: "user", sessionId: "session-b" });
  check(
    "a hold from another session reads as not found",
    !stranger.ok && stranger.reason === "not-found",
  );
  check("and nothing reached PayPal", count("POST /v2/payments") === 0);
}

// Two decisions racing on one hold produce one PayPal call.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  const [a, b] = await Promise.all([
    payments.keep(hold.id, { decidedBy: "user" }),
    payments.letGo(hold.id, { decidedBy: "clock" }),
  ]);
  check("a race between keep and let-go has one winner", [a.ok, b.ok].filter(Boolean).length === 1);
  check("and makes one PayPal call", count("POST /v2/payments") === 1, fake.calls.join(" | "));
}

// The clock voids only what is due.
reset();
{
  const due = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  const fresh = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  globalThis.__bucketHolds.get(due.id).deadlineAt = Date.now() - 1;
  const swept = await payments.sweepExpired();
  const afterDue = await holds.getHold(due.id);
  const afterFresh = await holds.getHold(fresh.id);
  check(
    "the sweep voids a hold past its deadline",
    afterDue.state === "voided" && afterDue.decidedBy === "clock",
  );
  check("the sweep leaves a hold still inside its window", afterFresh.state === "held");
  check("the sweep reports what it did", swept.length === 1 && swept[0].ok);
}

// A capture that succeeded at PayPal but lost its response is recorded as captured.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  fake.captureFailsAfterApplying = true;
  const kept = await payments.keep(hold.id, { decidedBy: "user" });
  check(
    "a lost capture response is reconciled from PayPal's record",
    kept.ok && kept.hold.state === "captured",
  );
}

// A void PayPal rejects leaves the hold held, with the error visible.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  fake.voidFailsHard = true;
  const result = await payments.letGo(hold.id, { decidedBy: "user" });
  check("a failed void reports the PayPal error", !result.ok && result.reason === "paypal-error");
  check(
    "and leaves the money held, error recorded",
    result.hold.state === "held" && !!result.hold.lastError,
  );
  fake.voidFailsHard = false;
  const retry = await payments.letGo(hold.id, { decidedBy: "user" });
  check("and the same hold can be let go on retry", retry.ok && retry.hold.state === "voided");
}

// A person cannot keep a want after its window closed. The clock ends it instead.
reset();
{
  const hold = await payments.placeHold({
    ...base,
    bucketId: "bucket-gear",
    bucketTag: "want",
    verdict: "hold",
  });
  globalThis.__bucketHolds.get(hold.id).deadlineAt = Date.now() - 1;
  const late = await payments.keep(hold.id, { decidedBy: "user", sessionId: "session-a" });
  check(
    "keeping a want after its window is refused as expired",
    !late.ok && late.reason === "expired",
    late.ok ? "kept" : late.reason,
  );
  check(
    "and the clock voids it instead of capturing",
    late.hold?.state === "voided" &&
      late.hold?.decidedBy === "clock" &&
      count("POST /v2/payments/authorizations") === 1 &&
      fake.calls.some((c) => c.endsWith("/void")),
    fake.calls.join(" | "),
  );
}

// The checkout policy: deterministic, and a model can only ever add a hold.
{
  const { decidePolicy, parsePolicyInput } = await importBundle(
    await build({
      entryPoints: ["src/lib/server/policy.ts"],
      bundle: true,
      platform: "neutral",
      format: "esm",
      write: false,
      logLevel: "error",
      alias: { "@": resolve("src") },
    }),
  );
  const d = (input) => decidePolicy(input).decision;
  check("policy: a need captures", d({ bucketTag: "need", amountCents: 1250 }) === "capture");
  check(
    "policy: a want over the threshold holds",
    d({ bucketTag: "want", amountCents: 8999 }) === "hold",
  );
  check("policy: a small want passes", d({ bucketTag: "want", amountCents: 1500 }) === "capture");
  check(
    "policy: a screen mismatch holds a need",
    d({ bucketTag: "need", amountCents: 1250, screen: "mismatch" }) === "hold",
  );
  check(
    "policy: a screen agreement never releases a held want",
    d({ bucketTag: "want", amountCents: 8999, screen: "agree" }) === "hold",
  );
  check(
    "policy: malformed requests are refused",
    [
      { bucketTag: "maybe", amountCents: 100 },
      { bucketTag: "want", amountCents: 12.5 },
      { bucketTag: "want", amountCents: -1 },
      { bucketTag: "want", amountCents: 100, screen: "approve" },
      null,
    ].every((x) => parsePolicyInput(x) === null),
  );
}

// One token serves every call.
check(
  "one access token served every call in this run",
  fake.tokenRequests === 1,
  `${fake.tokenRequests} requests`,
);

// Amounts: whole cents only.
{
  let threw = false;
  try {
    await payments.placeHold({
      ...base,
      amountCents: 24.99,
      bucketId: "bucket-gear",
      bucketTag: "want",
      verdict: "hold",
    });
  } catch {
    threw = true;
  }
  check("a fractional-cent amount is refused before PayPal", threw);
}

// The demo clock is honored, and capped inside PayPal's honor period.
process.env.HOLD_WINDOW_MINUTES = "3";
check(
  "HOLD_WINDOW_MINUTES shortens the window for the demo",
  payments.holdWindowMs() === 3 * 60_000,
);
process.env.HOLD_WINDOW_MINUTES = "100000";
check(
  "the window never exceeds PayPal's 3-day honor period",
  payments.holdWindowMs() < 3 * 24 * 60 * 60_000,
);
delete process.env.HOLD_WINDOW_MINUTES;

// No credentials, no network.
{
  delete process.env.PAYPAL_CLIENT_ID;
  globalThis.__bucketPayPalToken = undefined;
  const before = fake.calls.length;
  let name = "";
  try {
    await payments.placeHold({
      ...base,
      bucketId: "bucket-gear",
      bucketTag: "want",
      verdict: "hold",
    });
  } catch (error) {
    name = error.name;
  }
  check(
    "missing credentials fail before any network call",
    name === "PayPalNotConfigured" && fake.calls.length === before,
    name,
  );
}

console.log(failures === 0 ? "\nAll payment checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

// --- helpers ----------------------------------------------------------------------------------

async function importBundle(result) {
  const dir = mkdtempSync(join(tmpdir(), "bucket-payments-"));
  const file = join(dir, `bundle-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, result.outputFiles[0].contents);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
