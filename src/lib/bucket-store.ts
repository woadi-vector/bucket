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

/**
 * Whether a bucket holds needs or wants. The person decides this once, when they create the
 * bucket, away from any purchase, and it becomes the line Bucket holds them to: a purchase
 * filed under a need passes unless it reads like a want; a want over the threshold waits.
 */
export type BucketTag = "need" | "want";

export type Bucket = {
  id: string;
  name: string;
  balance: number;
  limit: number | null;
  ownerType: "self" | "child";
  iconKey: BucketIconKey;
  /** Soft accent token, used as background tint for the icon chip. */
  accent: string;
  /**
   * Optional so state saved before tags existed still loads. Read it through
   * {@link resolveBucketTag}, never directly, so an old bucket gets a sensible default.
   */
  tag?: BucketTag;
  /** Wants at or above this many dollars wait in Sleep On It. Unset means SLEEP_THRESHOLD. */
  holdThreshold?: number | null;
};

/** Default tag for a bucket saved before tags existed, by what its icon says it is for. */
const DEFAULT_TAG_BY_ICON: Record<BucketIconKey, BucketTag> = {
  groceries: "need",
  kids: "need",
  savings: "need",
  dining: "want",
  default: "want",
};

export const resolveBucketTag = (bucket: Pick<Bucket, "tag" | "iconKey">): BucketTag =>
  bucket.tag ?? DEFAULT_TAG_BY_ICON[bucket.iconKey] ?? "want";

/** The bucket's own hold threshold in dollars, or the app default. */
export const resolveHoldThreshold = (bucket: Pick<Bucket, "holdThreshold">): number =>
  typeof bucket.holdThreshold === "number" && bucket.holdThreshold >= 0
    ? bucket.holdThreshold
    : SLEEP_THRESHOLD;

/** How a person answered a contested tag. Bucket advises; this is them deciding. */
export type VerdictResponse = "retracted" | "overridden";

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
    tag: "need",
  },
  {
    id: "b2",
    name: "Dining Out",
    balance: 85,
    limit: null,
    ownerType: "self",
    iconKey: "dining",
    accent: "oklch(0.93 0.045 65)",
    tag: "want",
  },
  {
    id: "b3",
    name: "Kids' Allowance",
    balance: 50,
    limit: null,
    ownerType: "child",
    iconKey: "kids",
    accent: "oklch(0.92 0.05 35)",
    tag: "need",
  },
  {
    id: "b4",
    name: "Savings",
    balance: 1200,
    limit: null,
    ownerType: "self",
    iconKey: "savings",
    accent: "oklch(0.91 0.05 195)",
    tag: "need",
  },
  {
    // Where the shopping agent files gear, gadgets and clothes. A want bucket, so anything
    // over its threshold waits in Sleep On It as a live PayPal hold.
    id: "b5",
    name: "Gear & Fun",
    balance: 150,
    limit: null,
    ownerType: "self",
    iconKey: "default",
    accent: "oklch(0.93 0.03 280)",
    tag: "want",
  },
];

export const SAVINGS_BUCKET_ID = "b4";

export const DEFAULT_BUCKET_ICON_KEY: BucketIconKey = "default";
export const DEFAULT_BUCKET_ACCENT = "oklch(0.93 0.025 160)";

export const formatCurrency = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
