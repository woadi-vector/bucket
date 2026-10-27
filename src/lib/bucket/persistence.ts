import {
  Bucket,
  SAVINGS_BUCKET_ID,
  DEFAULT_SLEEP_THRESHOLD,
  initialBuckets,
  type Cover,
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
export const STATE_VERSION = 2;

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
  (v.limit === null || typeof v.limit === "number") &&
  (v.tag === undefined || v.tag === "need" || v.tag === "want") &&
  (v.holdThreshold === undefined ||
    v.holdThreshold === null ||
    (typeof v.holdThreshold === "number" && v.holdThreshold >= 0));

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

const isCover = (v: unknown): v is Cover =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.amount === "number" &&
  typeof v.fromBucketId === "string" &&
  typeof v.toBucketId === "string" &&
  typeof v.timestamp === "number";

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

  const {
    buckets,
    startingBalances,
    transactions,
    covers,
    pending,
    parentRequests,
    savedByPause,
    sleepThreshold,
    trip,
    releaseTo,
    releasedHoldIds,
  } = state;

  if (!Array.isArray(buckets) || !buckets.every(isBucket) || buckets.length === 0) return null;
  if (!isObject(startingBalances)) return null;
  if (!Array.isArray(transactions) || !transactions.every(isTransaction)) return null;
  if (!Array.isArray(covers) || !covers.every(isCover)) return null;
  if (!Array.isArray(pending) || !pending.every(isPending)) return null;
  if (!Array.isArray(parentRequests) || !parentRequests.every(isParentRequest)) return null;
  if (typeof savedByPause !== "number" || !Number.isFinite(savedByPause)) return null;
  if (trip !== null && !isObject(trip)) return null;
  // Both are optional so states saved before the setting existed still load.
  if (releaseTo !== undefined && releaseTo !== "bucket" && releaseTo !== "savings") return null;
  if (
    releasedHoldIds !== undefined &&
    !(
      Array.isArray(releasedHoldIds) &&
      releasedHoldIds.length <= 500 &&
      releasedHoldIds.every((id) => typeof id === "string" && id.length <= 64)
    )
  ) {
    return null;
  }

  return {
    buckets,
    startingBalances: startingBalances as Record<string, number>,
    transactions,
    covers,
    pending,
    parentRequests,
    savedByPause,
    // Absent on rows written before this was adjustable. Defaulted rather than rejected: a
    // missing preference is not a corrupt row, and discarding someone's whole ledger over a
    // field they never had the chance to set would be the wrong trade.
    sleepThreshold:
      typeof sleepThreshold === "number" && Number.isFinite(sleepThreshold) && sleepThreshold >= 0
        ? sleepThreshold
        : DEFAULT_SLEEP_THRESHOLD,
    trip: (trip ?? null) as Trip | null,
    ...(releaseTo !== undefined ? { releaseTo: releaseTo as "bucket" | "savings" } : {}),
    ...(releasedHoldIds !== undefined ? { releasedHoldIds: releasedHoldIds as string[] } : {}),
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
 * The shape of this history is load-bearing, not decoration. Bucket judges a label against
 * the person's own past labels, and the model is told to speak up when someone calls
 * something a need and their history shows they routinely call comforts needs. An honestly
 * labelled history therefore produces an app that agrees with everything: a visitor would
 * have to log four or five purchases of their own before Bucket had grounds to contest one,
 * and the thing the whole app is for would never happen in the time anyone gives it.
 *
 * So the habit is here, on purpose. Four of these call convenience food a need: a skipped
 * packed lunch, a coffee on the way in, snacks bought with the groceries, takeout at the end
 * of a long day. None of them are absurd, and that is the point. This is what the stretch
 * actually looks like in a real person's week, and Bucket is supposed to notice it without
 * being snide about it. The genuine needs and the honestly labelled wants are here too,
 * because a history of nothing but self-deception would be a strawman and would also teach
 * the model the wrong thing.
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
      timestamp: now - 11 * DAY,
      readinessTag: null,
    },
    {
      amount: 16,
      label: "Lunch out, no time to pack one",
      bucketId: "b2",
      intent: "need",
      timestamp: now - 9 * DAY,
      readinessTag: "impulse",
    },
    {
      amount: 31,
      label: "Ramen with friends",
      bucketId: "b2",
      intent: "want",
      timestamp: now - 7 * DAY,
      readinessTag: "saw_today",
    },
    {
      amount: 9,
      label: "Coffee and a pastry before work",
      bucketId: "b2",
      intent: "need",
      timestamp: now - 6 * DAY,
      readinessTag: "impulse",
    },
    {
      amount: 27,
      label: "Snacks and energy drinks",
      bucketId: "b1",
      intent: "need",
      timestamp: now - 4 * DAY,
      readinessTag: "impulse",
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
      amount: 34,
      label: "Takeout, too tired to cook",
      bucketId: "b2",
      intent: "need",
      timestamp: now - 1 * DAY,
      readinessTag: "impulse",
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
