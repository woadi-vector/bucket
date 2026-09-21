import {
  Bucket,
  SAVINGS_BUCKET_ID,
  initialBuckets,
  type ParentRequest,
  type PendingWant,
  type Transaction,
  type Trip,
} from "@/lib/bucket-store";
import { createInitialState, type BucketState } from "./reducer";

/**
 * Bumped whenever {@link BucketState}'s shape changes incompatibly. A stored row with a
 * different version is discarded rather than migrated — this is throwaway demo state, and
 * a wrong migration is worse than a fresh seed.
 */
export const STATE_VERSION = 1;

export type PersistedState = {
  version: number;
  state: BucketState;
};

export function serializeState(state: BucketState): string {
  return JSON.stringify({ version: STATE_VERSION, state } satisfies PersistedState);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isBucket = (v: unknown): v is Bucket =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.name === "string" &&
  typeof v.balance === "number" &&
  typeof v.iconKey === "string" &&
  typeof v.accent === "string" &&
  (v.ownerType === "self" || v.ownerType === "child") &&
  (v.limit === null || typeof v.limit === "number");

const isTransaction = (v: unknown): v is Transaction =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.amount === "number" &&
  typeof v.label === "string" &&
  typeof v.bucketId === "string" &&
  (v.intent === "want" || v.intent === "need") &&
  typeof v.timestamp === "number";

const isPending = (v: unknown): v is PendingWant =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.amount === "number" &&
  typeof v.label === "string" &&
  typeof v.bucketId === "string" &&
  (v.intent === "want" || v.intent === "need");

const isParentRequest = (v: unknown): v is ParentRequest =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.amount === "number" &&
  (v.status === "pending" || v.status === "approved" || v.status === "denied");

/**
 * Structural check on an untrusted {@link BucketState}.
 *
 * Used for both directions: rows read out of a database that outlives any given deploy,
 * and state posted by a client. A partial match must fail rather than produce a half-built
 * state that crashes on render or writes nonsense to storage.
 */
export function validateBucketState(state: unknown): BucketState | null {
  if (!isObject(state)) return null;

  const { buckets, startingBalances, transactions, pending, parentRequests, savedByPause, trip } =
    state;

  if (!Array.isArray(buckets) || !buckets.every(isBucket) || buckets.length === 0) return null;
  if (!isObject(startingBalances)) return null;
  if (!Array.isArray(transactions) || !transactions.every(isTransaction)) return null;
  if (!Array.isArray(pending) || !pending.every(isPending)) return null;
  if (!Array.isArray(parentRequests) || !parentRequests.every(isParentRequest)) return null;
  if (typeof savedByPause !== "number" || !Number.isFinite(savedByPause)) return null;
  if (trip !== null && !isObject(trip)) return null;

  return {
    buckets,
    startingBalances: startingBalances as Record<string, number>,
    transactions,
    pending,
    parentRequests,
    savedByPause,
    trip: (trip ?? null) as Trip | null,
  };
}

/** Parses a stored row back into state, or null if it is unusable. */
export function deserializeState(raw: string): BucketState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.version !== STATE_VERSION) return null;
  return validateBucketState(parsed.state);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The state a first-time visitor sees.
 *
 * A judge opens the deployed URL cold and must land on a populated app, not an empty one:
 * the insight panels are meaningless with no history, and the pending tray needs an item
 * so the let-it-go moment is one click away.
 *
 * Note this is NOT what "Play demo" resets to — the scripted walkthrough tells its story
 * from zero and uses {@link createInitialState}.
 */
export function createSeededState(now: number = Date.now()): BucketState {
  const spend: Array<Omit<Transaction, "id">> = [
    {
      amount: 86,
      label: "Weekly shop",
      bucketId: "b1",
      intent: "need",
      timestamp: now - 6 * DAY,
      readinessTag: null,
    },
    {
      amount: 31,
      label: "Ramen with friends",
      bucketId: "b2",
      intent: "want",
      timestamp: now - 4 * DAY,
      readinessTag: "saw_today",
    },
    {
      amount: 24,
      label: "Farmers market",
      bucketId: "b1",
      intent: "need",
      timestamp: now - 2 * DAY,
      readinessTag: null,
    },
    {
      amount: 6,
      label: "Oat latte",
      bucketId: "b2",
      intent: "want",
      timestamp: now - 9 * HOUR,
      readinessTag: "impulse",
    },
  ];

  // Fresh uuids per visitor, not fixed ids. The transactions table is keyed on this id and
  // inserted with INSERT OR IGNORE, so shared seed ids would mean only the very first
  // visitor's rows ever landed and every later one was silently dropped.
  const transactions: Transaction[] = spend
    .map((t) => ({ ...t, id: crypto.randomUUID() }))
    .sort((a, b) => b.timestamp - a.timestamp);

  // A want released earlier in the week, so the hero number is not zero on arrival.
  const savedByPause = 54;

  const spentByBucket = transactions.reduce<Record<string, number>>((acc, t) => {
    acc[t.bucketId] = (acc[t.bucketId] ?? 0) + t.amount;
    return acc;
  }, {});

  const buckets = initialBuckets.map((b) => {
    const spent = spentByBucket[b.id] ?? 0;
    // Releasing a want credits Savings, and its starting balance moves with it so the
    // card does not read the incoming money as "spent" — same rule as CREDIT_SAVINGS.
    const credited = b.id === SAVINGS_BUCKET_ID ? savedByPause : 0;
    return { ...b, balance: b.balance - spent + credited };
  });

  const startingBalances = Object.fromEntries(
    initialBuckets.map((b) => [
      b.id,
      b.id === SAVINGS_BUCKET_ID ? b.balance + savedByPause : b.balance,
    ]),
  );

  const pending: PendingWant[] = [
    {
      id: crypto.randomUUID(),
      amount: 79,
      label: "Wireless earbuds",
      bucketId: "b2",
      createdAt: now - 5 * HOUR,
      hoursLeft: 19,
      intent: "want",
      readinessTag: "impulse",
    },
  ];

  return {
    ...createInitialState(),
    buckets,
    startingBalances,
    transactions,
    pending,
    savedByPause,
  };
}
