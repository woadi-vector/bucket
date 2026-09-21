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

export type Transaction = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  intent: "want" | "need";
  timestamp: number;
  readinessTag: ReadinessTag | null;
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
    balance: 85,
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
