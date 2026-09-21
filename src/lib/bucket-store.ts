import type { LucideIcon } from "lucide-react";
import { ShoppingBasket, UtensilsCrossed, Backpack, PiggyBank, Wallet } from "lucide-react";

export type ReadinessTag = "impulse" | "saw_today" | "over_a_week" | "replacing";

export const READINESS_OPTIONS: { id: ReadinessTag; label: string }[] = [
  { id: "impulse", label: "Impulse" },
  { id: "saw_today", label: "Saw it today" },
  { id: "over_a_week", label: "Wanted > 1 week" },
  { id: "replacing", label: "Replacing" },
];

export type Bucket = {
  id: string;
  name: string;
  balance: number;
  limit: number | null;
  ownerType: "self" | "child";
  icon: LucideIcon;
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

export type PendingWant = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  createdAt: number;
  hoursLeft: number;
};

export type ParentRequest = {
  id: string;
  amount: number;
  label: string;
  bucketId: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
};

export const initialBuckets: Bucket[] = [
  { id: "b1", name: "Groceries", balance: 420, limit: null, ownerType: "self", icon: ShoppingBasket, accent: "oklch(0.92 0.04 145)" },
  { id: "b2", name: "Dining Out", balance: 85, limit: null, ownerType: "self", icon: UtensilsCrossed, accent: "oklch(0.93 0.045 65)" },
  { id: "b3", name: "Kids' Allowance", balance: 50, limit: null, ownerType: "child", icon: Backpack, accent: "oklch(0.92 0.05 35)" },
  { id: "b4", name: "Savings", balance: 1200, limit: null, ownerType: "self", icon: PiggyBank, accent: "oklch(0.91 0.05 195)" },
];

export const SAVINGS_BUCKET_ID = "b4";

export const DEFAULT_BUCKET_ICON: LucideIcon = Wallet;
export const DEFAULT_BUCKET_ACCENT = "oklch(0.93 0.025 160)";

export const formatCurrency = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });