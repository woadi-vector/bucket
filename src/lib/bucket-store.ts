import type { LucideIcon } from "lucide-react";
import { ShoppingBasket, UtensilsCrossed, Backpack, PiggyBank, Wallet } from "lucide-react";

export type ReadinessTag = "impulse" | "saw_today" | "over_a_week" | "replacing";

export const READINESS_OPTIONS: { id: ReadinessTag; label: string }[] = [
  { id: "impulse", label: "Impulse" },
  { id: "saw_today", label: "Saw it today" },
  { id: "over_a_week", label: "Wanted > 1 week" },
  { id: "replacing", label: "Replacing" },
];

/** Wants above this land in the Sleep On It tray instead of committing immediately. */
export const SLEEP_THRESHOLD = 40;

/**
 * Buckets get persisted (Phase 2), so a Bucket stores an icon *key*, not the icon
 * component itself — a React component cannot survive a round trip through JSON.
 */
export type BucketIconKey = "groceries" | "dining" | "kids" | "savings" | "default";

const BUCKET_ICONS: Record<BucketIconKey, LucideIcon> = {
  groceries: ShoppingBasket,
  dining: UtensilsCrossed,
  kids: Backpack,
  savings: PiggyBank,
  default: Wallet,
};

/** Falls back to the default so an unknown key out of storage can never crash a render. */
export const resolveBucketIcon = (key: BucketIconKey | undefined): LucideIcon =>
  (key && BUCKET_ICONS[key]) || BUCKET_ICONS.default;

export type Bucket = {
  id: string;
  name: string;
  balance: number;
  limit: number | null;
  ownerType: "self" | "child";
  iconKey: BucketIconKey;
  /** Soft accent token, used as background tint for the icon chip. */
  accent: string;
};

/** How a person answered a contested tag. Bucket advises; this is them deciding. */
export type VerdictResponse = "retracted" | "overridden";

/**
 * Which tiers answered, for display on a contested card.
 *
 * The one deliberate exception to telemetry staying server-side, and it is narrow: model
 * identifiers only, never token counts, never cost. The reason it exists is that the whole
 * claim of this app is that it escalates on human disagreement rather than on task
 * difficulty, and a person looking at a contested card has no way to tell that two different
 * models were involved in producing it. Aggregate numbers on `/efficiency` describe the
 * pattern; this names what happened in the single case being looked at.
 *
 * Attached only to a spoken contest. A withheld or overruled verdict leaves the server
 * looking like an ordinary agreement by design, and naming an escalation on one would
 * announce the contest that was deliberately dropped.
 */
export type VerdictAttribution = {
  /** The cheap tier that screened the purchase. A raw model id, as the adapter reported it. */
  screened: string;
  /** The expensive tier that sustained the contest, when one was consulted. */
  adjudicated?: string;
  /** Which adapter answered, so the card only claims real infrastructure. */
  provider?: string;
};

/**
 * A model id shortened for display, falling back to the id itself.
 *
 * Deliberately forgiving rather than exhaustive. The raw identifier travels from the engine
 * so the card can never name a model that did not run, and this only makes it readable:
 * `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` becomes `Nemotron Nano`. An unrecognized id comes
 * back verbose rather than wrong, which is the right way round for a label that is making a
 * factual claim about what just happened.
 */
export function shortModelName(model: string): string {
  const name = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const size = name.match(/\b(nano|mini|small|super|ultra|large)\b/i)?.[1];

  if (/nemotron/i.test(name) && size) {
    return `Nemotron ${size[0].toUpperCase()}${size.slice(1).toLowerCase()}`;
  }

  return name;
}

/**
 * The app's view of an engine verdict: the four contract fields and nothing else.
 *
 * Declared here rather than imported from `@/engine` because this is deliberately a
 * *subset*. The engine's `Verdict` also carries telemetry naming the model and its token
 * cost, and that stays server-side — it is written to `model_usage` and surfaced only as
 * an aggregate. Nothing shipped to the browser says which model answered.
 */
export type PurchaseVerdict = {
  agrees: boolean;
  verdict: "want" | "need";
  confidence: number;
  reasoning: string;
  /** True when served from the global spend ceiling rather than by a model. */
  cached?: boolean;
  /**
   * True when Bucket disagreed and decided the disagreement was not worth saying.
   *
   * `agrees` still reports the disagreement, so this is what the difference between
   * objecting and interrupting rests on. Nothing that could display the argument travels
   * with it: `reasoning` arrives empty and there is no question. Treat it as a hard stop on
   * surfacing anything, not as a style hint.
   */
  withheld?: boolean;
  /**
   * Which tiers produced this verdict. Present only on a spoken contest.
   *
   * Carries model identifiers and nothing else: no token counts, no cost. See
   * {@link VerdictAttribution} for why this one piece of telemetry crosses to the browser.
   */
  attribution?: VerdictAttribution;
  /**
   * What Bucket wants to ask before it reclassifies anything.
   *
   * Present only on a spoken contest. It is an invitation rather than a gate: the person can
   * ignore it, answer it, or override the verdict outright, and the purchase stands either
   * way until they say otherwise.
   */
  question?: string;
  /**
   * The stored challenge this verdict belongs to.
   *
   * Carried so an explanation can be attached to the exact exchange it answers. Absent is
   * normal and not an error: the write may have failed, and the log writes a standalone row
   * in that case rather than losing the reconsideration.
   */
  exchangeId?: string;
  /**
   * Set only on a reconsideration: whether the explanation changed Bucket's mind.
   *
   * Derived server-side from the new verdict rather than reported by the model, for the same
   * reason `agrees` is. This decides which of two opposite things a person is told, so it
   * must never rest on a model being asked to restate a judgement it already made.
   */
  explanationAccepted?: boolean;
};

export type Transaction = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  intent: "want" | "need";
  timestamp: number;
  readinessTag: ReadinessTag | null;
  /** Filled in asynchronously after the purchase is logged; null while in flight. */
  verdict?: PurchaseVerdict | null;
  /**
   * What the person did when Bucket contested this tag.
   *
   * The plan requires recording both the model's verdict and the user's final call, and this
   * is the second half. `null` means they have not been asked yet or the engine agreed.
   */
  verdictResponse?: VerdictResponse | null;
  /**
   * Bucket's answer after the person explained themselves.
   *
   * Kept beside the original verdict rather than replacing it, because the card has to show
   * both: the argument that was made, and what happened to it. Overwriting would leave a
   * person looking at a conclusion with no record of what it was a conclusion about.
   */
  reconsideration?: PurchaseVerdict | null;
};

/**
 * An item parked in the Sleep On It tray.
 *
 * `intent` and `readinessTag` are carried through deliberately. The tray is where the
 * expensive model adjudicates a contested tag (Phase 4), and it needs both the call the
 * user made and how long they had wanted the thing. The prototype dropped both here,
 * which discarded the only signal that makes a retraction meaningful.
 */
export type PendingWant = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  createdAt: number;
  hoursLeft: number;
  intent: "want" | "need";
  readinessTag: ReadinessTag | null;
  /** Filled in asynchronously while the item sits in the tray; null while in flight. */
  verdict?: PurchaseVerdict | null;
};

/**
 * A deliberate move of money from one bucket to another, to clear a negative.
 *
 * Kept out of {@link Transaction} on purpose. The verdict prompt is handed the last twenty
 * transactions as the person's spending history, and a transfer is not a purchase: it has
 * no intent to judge and no readiness to weigh, and feeding it to the model would teach it
 * that someone "bought" $250 of Groceries they never ate. Covers live in their own list,
 * nothing in the engine reads them, and the ledger interleaves them for display so the
 * bucket totals can still be reconciled by anyone who adds them up.
 */
export type Cover = {
  id: string;
  amount: number;
  /** The bucket the money came out of. */
  fromBucketId: string;
  /** The bucket that was underwater. */
  toBucketId: string;
  timestamp: number;
};

export type ParentRequest = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
};

export type TripItem = {
  id: string;
  name: string;
  price: number; // 0 if unestimated
  checked: boolean;
};

export type Trip = {
  bucketId: string;
  items: TripItem[];
};

export const initialBuckets: Bucket[] = [
  {
    id: "b1",
    name: "Groceries",
    balance: 420,
    limit: null,
    ownerType: "self",
    iconKey: "groceries",
    accent: "oklch(0.92 0.04 145)",
  },
  {
    id: "b2",
    name: "Dining Out",
    // Sized to hold the seeded fortnight of eating out without going negative. The seed
    // leans on this bucket, because convenience food is where the habit Bucket is built to
    // notice actually shows up.
    balance: 220,
    limit: null,
    ownerType: "self",
    iconKey: "dining",
    accent: "oklch(0.93 0.045 65)",
  },
  {
    id: "b3",
    name: "Kids' Allowance",
    balance: 50,
    limit: null,
    ownerType: "child",
    iconKey: "kids",
    accent: "oklch(0.92 0.05 35)",
  },
  {
    /**
     * Everything that is not food, childcare or saved, and deliberately empty.
     *
     * Two problems are being solved at once here, and they pull in opposite directions.
     *
     * Without a bucket like this, a shoe or a pair of headphones has no home, and the
     * first thing anyone does on arriving is pause over which of four wrong buckets to
     * charge it to. That hesitation lands in the opening seconds, before Bucket has said
     * anything, and it is friction about filing rather than about money.
     *
     * But funding it would be worse. A bucket with $300 in it that nothing else competes
     * for is a slush fund, and a slush fund is where the point of this app goes to die:
     * every unclassifiable purchase lands somewhere painless and nothing is ever traded
     * against anything. The feeling Bucket exists to produce is not that a card was
     * charged, it is that groceries got smaller.
     *
     * So it starts at zero. Choosing it is obvious and instant, and the purchase picker
     * then shows `$0 → -$250` in red beside `Groceries $283 → $33`, which is the whole
     * argument made without a modal, a warning or a block. Spending past zero is allowed.
     * The negative stands on the card afterwards as a running tab of everything bought
     * that fit nowhere, and covering it is an act the person chooses, not one the app
     * extracts. Nothing here prevents a purchase; it only makes the cost legible while
     * there is still time to feel it.
     */
    id: "b5",
    name: "Everything Else",
    balance: 0,
    limit: null,
    ownerType: "self",
    iconKey: "default",
    accent: "oklch(0.92 0.035 275)",
  },
  {
    id: "b4",
    name: "Savings",
    balance: 1200,
    limit: null,
    ownerType: "self",
    iconKey: "savings",
    accent: "oklch(0.91 0.05 195)",
  },
];

export const SAVINGS_BUCKET_ID = "b4";

export const DEFAULT_BUCKET_ICON_KEY: BucketIconKey = "default";
export const DEFAULT_BUCKET_ACCENT = "oklch(0.93 0.025 160)";

export const formatCurrency = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
