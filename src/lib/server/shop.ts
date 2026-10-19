import {
  chooseProduct,
  verifyMatch,
  createTokenFactoryAdapter,
  judgeTransaction,
  type Verdict,
  type VerdictRequest,
} from "@/engine";
import {
  resolveBucketTag,
  resolveHoldThreshold,
  SAVINGS_BUCKET_ID,
  type Bucket,
  type BucketTag,
} from "@/lib/bucket-store";
import { getSecret } from "@/lib/server-env";
import { checkBudget, checkGlobalCeiling, recordUsage } from "@/lib/server/budget";
import { searchProducts, type ProductOption } from "@/lib/server/channel3";
import { recordChallenge } from "@/lib/server/exchanges";
import { toPublicHold, type PublicHold } from "@/lib/server/holds";
import { placeHold } from "@/lib/server/payments";
import { recordRefusal } from "@/lib/server/refusals";
import { decidePolicy, type PolicyDecision } from "@/lib/server/policy";
import { getStore } from "@/lib/server/store";

/**
 * One agent purchase, end to end: search, choose, screen, decide, hold.
 *
 *   1. Channel3 finds products under the person's price ceiling.
 *   2. The agent (Nemotron Super) picks one and files it into one of the person's buckets. It
 *      never sees which buckets are needs, so it cannot route around a pause.
 *   3. If the bucket is a need, the screen (the same engine the Nebius build uses) checks
 *      whether the purchase actually reads like one. A want bucket skips this: the bucket's
 *      threshold already decides, and no screen result can release a held want.
 *   4. The policy turns the bucket's tag, the threshold and the screen into capture or hold.
 *   5. The payments module places the PayPal hold from the saved wallet, and captures it at
 *      once only when the policy said capture.
 *
 * Models sit in steps 2 and 3 and nowhere else. Their outputs are a product number, a bucket
 * id, and a need-or-want word. Steps 4 and 5 are code.
 */

export type ShopInput = {
  sessionId: string;
  request: string;
  maxPriceCents?: number;
};

export type ShopScreen =
  | { ran: false; why: string }
  | {
      ran: true;
      agrees: boolean;
      verdict: "need" | "want";
      reasoning: string;
      question?: string;
      exchangeId?: string;
      cached?: boolean;
    };

export type ShopResult =
  | {
      ok: true;
      product: ProductOption;
      bucket: { id: string; name: string; tag: BucketTag; holdThresholdCents: number };
      agent: { reason: string; degraded: boolean };
      /** The second model's view of the pairing. `ran: false` means it was not checked. */
      check: { ran: true; fits: true; reason: string } | { ran: false; why: string };
      screen: ShopScreen;
      policy: PolicyDecision;
      hold: PublicHold;
      considered: number;
    }
  | {
      ok: false;
      reason:
        | "no-results"
        | "declined"
        | "no-buckets"
        | "not-configured"
        | "search-failed"
        | "paypal-failed";
      message: string;
      /** How many catalog results the agent looked at before declining. */
      considered?: number;
      /** True when the agent picked something and the second check overruled the pick. */
      overruled?: boolean;
      /** What it looked at, so a decline can be judged by the person instead of trusted. */
      options?: { title: string; priceCents: number; merchant: string; category: string | null }[];
      /** On an overrule: the product the agent picked, which the second check refused. */
      rejected?: { title: string; priceCents: number; merchant: string; category: string | null };
      /** On an overrule: the second check's own words, apart from the summary message. */
      checkReason?: string;
      /** The ledger row this refusal was written to. */
      refusalId?: string;
    };

const toCents = (dollars: number) => Math.round(dollars * 100);

export async function runShop(input: ShopInput): Promise<ShopResult> {
  const { sessionId } = input;

  const vaultId = getSecret("PAYPAL_DEMO_VAULT_ID");
  if (!vaultId) {
    return {
      ok: false,
      reason: "not-configured",
      message: "No saved PayPal wallet is configured.",
    };
  }

  // The person's buckets come from their stored state, never from the browser, so a request
  // cannot invent a bucket or relabel a want as a need.
  const state = await getStore().load(sessionId);
  // The child's bucket is not the agent's to spend from, and neither is Savings: it is where
  // let-go money lands, not a budget to buy out of.
  const buckets: Bucket[] = (state?.buckets ?? []).filter(
    (b) => b.ownerType === "self" && b.id !== SAVINGS_BUCKET_ID,
  );
  // Where an unvalidated choice lands: the want bucket with the most money in it. A want
  // bucket so a fallback can never pass a purchase without the threshold check, and the
  // largest one because it is the likeliest general-purpose bucket.
  const wantBucket = buckets
    .filter((b) => resolveBucketTag(b) === "want")
    .sort((a, b) => b.balance - a.balance)[0];
  if (buckets.length === 0 || !wantBucket) {
    return {
      ok: false,
      reason: "no-buckets",
      message: "The agent needs at least one want bucket to file uncertain purchases into.",
    };
  }

  // 1. Search.
  let products: ProductOption[];
  try {
    products = await searchProducts({
      query: input.request,
      maxPriceCents: input.maxPriceCents,
      limit: 8,
    });
  } catch (error) {
    console.error("[shop] search failed", error);
    const notConfigured = error instanceof Error && error.name === "Channel3NotConfigured";
    return {
      ok: false,
      reason: notConfigured ? "not-configured" : "search-failed",
      message: notConfigured ? "Product search is not configured." : "Product search failed.",
    };
  }
  if (products.length === 0) {
    return { ok: false, reason: "no-results", message: "Nothing matched under that price." };
  }

  // 2. Choose. One budgeted call to Nemotron Super, recorded in the same ledger as every verdict.
  const apiKey = getSecret("NEBIUS_API_KEY");
  const allowed = apiKey ? (await checkBudget(sessionId, "nano")).allowed : false;
  const adapter = apiKey && allowed ? createTokenFactoryAdapter({ apiKey }) : undefined;

  const choice = await chooseProduct(
    {
      request: input.request.slice(0, 200),
      products,
      buckets: buckets.map((b) => ({ id: b.id, name: b.name })),
      fallbackBucketId: wantBucket.id,
    },
    { adapter, checkCeiling: checkGlobalCeiling },
  );
  await recordUsage({ sessionId, telemetry: choice.telemetry, agreed: true });

  // The agent looked and found nothing that is what was asked for. Nothing reaches PayPal.
  const options = products.map((p) => ({
    title: p.title,
    priceCents: p.priceCents,
    merchant: p.merchant,
    category: p.category,
  }));
  if (choice.declined) {
    const refusal = await recordRefusal({
      kind: "declined",
      request: input.request,
      maxCents: input.maxPriceCents ?? null,
      productTitle: null,
      priceCents: null,
      merchant: null,
      category: null,
      reason: choice.reason,
      considered: products.length,
    });
    return {
      ok: false,
      reason: "declined",
      message: choice.reason,
      considered: products.length,
      options,
      refusalId: refusal.id,
    };
  }

  const product = products[choice.productIndex];

  // 2b. A second model, with no stake in finding anything, checks the pairing. Its "no" ends the
  // request the same way a decline does.
  const check = await verifyMatch(input.request.slice(0, 200), product, {
    adapter,
    checkCeiling: checkGlobalCeiling,
  });
  await recordUsage({ sessionId, telemetry: check.telemetry, agreed: check.ran && check.fits });
  if (check.ran && !check.fits) {
    const checkReason = check.reason || "It is not the thing that was asked for.";
    const refusal = await recordRefusal({
      kind: "overruled",
      request: input.request,
      maxCents: input.maxPriceCents ?? null,
      productTitle: product.title,
      priceCents: product.priceCents,
      merchant: product.merchant,
      category: product.category,
      reason: checkReason,
      considered: products.length,
    });
    return {
      ok: false,
      reason: "declined",
      message: `The agent picked ${product.title}, and a second check overruled it: ${checkReason}`,
      overruled: true,
      considered: products.length,
      options,
      rejected: {
        title: product.title,
        priceCents: product.priceCents,
        merchant: product.merchant,
        category: product.category,
      },
      checkReason,
      refusalId: refusal.id,
    };
  }

  const bucket = buckets.find((b) => b.id === choice.bucketId) ?? wantBucket;
  const tag = resolveBucketTag(bucket);
  const holdThresholdCents = toCents(resolveHoldThreshold(bucket));

  // 3. Screen, for need buckets only.
  const screen = tag === "need" ? await screenPurchase(sessionId, product, bucket, state) : skip();

  // 4. Decide.
  const policy = decidePolicy({
    bucketTag: tag,
    amountCents: product.priceCents,
    holdThresholdCents,
    screen: screen.ran ? (screen.agrees ? "agree" : "mismatch") : undefined,
  });

  // 5. Hold, and capture straight away only when the policy passed it.
  try {
    const hold = await placeHold({
      sessionId,
      bucketId: bucket.id,
      bucketTag: tag,
      label: product.title,
      merchant: product.merchant,
      amountCents: product.priceCents,
      vaultId,
      verdict: policy.decision === "capture" ? "pass" : "hold",
    });
    return {
      ok: true,
      product,
      bucket: { id: bucket.id, name: bucket.name, tag, holdThresholdCents },
      agent: { reason: choice.reason, degraded: !!choice.telemetry.degraded },
      check: check.ran
        ? { ran: true, fits: true, reason: check.reason }
        : { ran: false, why: check.why },
      screen,
      policy,
      hold: toPublicHold(hold),
      considered: products.length,
    };
  } catch (error) {
    console.error("[shop] PayPal hold failed", error);
    return { ok: false, reason: "paypal-failed", message: "PayPal did not place the hold." };
  }
}

function skip(): ShopScreen {
  return { ran: false, why: "Want buckets are decided by their threshold, not the screen." };
}

/**
 * Asks the engine whether a purchase filed under a need actually reads like one. The bucket's
 * tag stands in for the person's own tag: it is the call they made when they set the bucket up.
 */
async function screenPurchase(
  sessionId: string,
  product: ProductOption,
  bucket: Bucket,
  state: Awaited<ReturnType<ReturnType<typeof getStore>["load"]>>,
): Promise<ShopScreen> {
  const names = new Map((state?.buckets ?? []).map((b) => [b.id, b.name]));
  const request: VerdictRequest = {
    purchase: {
      amount: product.priceCents / 100,
      label: product.title,
      intent: "need",
      readinessTag: null,
      bucketName: bucket.name,
      // The category is what tells "oat milk" the drink from "oat milk" the face cream.
      context: `Bought by a shopping agent from ${product.merchant}.${
        product.category ? ` Catalog category: ${product.category}.` : ""
      }`,
    },
    history: (state?.transactions ?? []).slice(0, 50).map((t) => ({
      amount: t.amount,
      label: t.label,
      intent: t.intent,
      readinessTag: t.readinessTag,
      timestamp: t.timestamp,
      bucketName: names.get(t.bucketId),
    })),
  };

  const apiKey = getSecret("NEBIUS_API_KEY");
  let verdict: Verdict;
  if (!apiKey || !(await checkBudget(sessionId, "nano")).allowed) {
    verdict = await judgeTransaction(request);
  } else {
    verdict = await judgeTransaction(request, {
      adapter: createTokenFactoryAdapter({ apiKey }),
      canEscalate: async () => (await checkBudget(sessionId, "ultra")).allowed,
      onUsage: ({ telemetry, agrees }) => recordUsage({ sessionId, telemetry, agreed: agrees }),
      checkCeiling: checkGlobalCeiling,
    });
  }

  // A contested need goes into the same exchange log as every other challenge.
  const exchangeId = verdict.agrees
    ? undefined
    : await recordChallenge({ sessionId, request, verdict });

  return {
    ran: true,
    agrees: verdict.agrees,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning,
    ...(verdict.question ? { question: verdict.question } : {}),
    ...(exchangeId ? { exchangeId } : {}),
    ...(verdict.cached ? { cached: true } : {}),
  };
}
