import { createContext, useContext, useMemo, useReducer, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  DEFAULT_BUCKET_ACCENT,
  DEFAULT_BUCKET_ICON_KEY,
  ReadinessTag,
  SAVINGS_BUCKET_ID,
  Trip,
  formatCurrency,
} from "@/lib/bucket-store";
import { useBucketSounds } from "@/lib/use-bucket-sounds";
import { useEvent } from "@/lib/use-event";
import { bucketReducer, createInitialState, type BucketState } from "./reducer";

export type Tab = "buckets" | "pending" | "family";

export type Prefill = {
  amount: number;
  label: string;
  intent?: "want" | "need";
  bucketId?: string;
} | null;

export type FlyingCoin = {
  key: number;
  amount: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
} | null;

/** Presentation state. Deliberately not part of {@link BucketState} — none of it is persisted. */
type UiState = {
  tab: Tab;
  purchaseOpen: boolean;
  newBucketOpen: boolean;
  tripOpen: boolean;
  scanning: boolean;
  parentMode: boolean;
  muted: boolean;
  justUpdatedId: string | null;
  prefill: Prefill;
  flying: FlyingCoin;
};

type PurchaseInput = {
  amount: number;
  label: string;
  bucketId: string;
  intent: "want" | "need";
  readinessTag?: ReadinessTag | null;
};

type SleepInput = {
  amount: number;
  label: string;
  bucketId: string;
  intent?: "want" | "need";
  readinessTag?: ReadinessTag | null;
};

export type BucketActions = {
  confirmPurchase: (data: PurchaseInput) => void;
  sleepOnIt: (data: SleepInput) => void;
  confirmPending: (id: string) => void;
  letItGo: (id: string, sourceRect?: DOMRect) => void;
  createParentRequest: (data: { amount: number; label: string; bucketId: string }) => void;
  approveRequest: (id: string) => void;
  denyRequest: (id: string) => void;
  createBucket: (name: string, amount: number) => void;
  setChildLimit: (value: string) => void;
  setTrip: (trip: Trip | null) => void;
  completeTrip: (checkedTotal: number) => void;
  resetAll: () => void;
  setTab: (tab: Tab) => void;
  setPurchaseOpen: (open: boolean) => void;
  setNewBucketOpen: (open: boolean) => void;
  setTripOpen: (open: boolean) => void;
  setScanning: (scanning: boolean) => void;
  setParentMode: (on: boolean) => void;
  toggleMuted: () => void;
  setPrefill: (prefill: Prefill) => void;
};

const StateContext = createContext<(BucketState & { ui: UiState }) | null>(null);
const ActionsContext = createContext<BucketActions | null>(null);

const INITIAL_UI: UiState = {
  tab: "buckets",
  purchaseOpen: false,
  newBucketOpen: false,
  tripOpen: false,
  scanning: false,
  parentMode: false,
  muted: true,
  justUpdatedId: null,
  prefill: null,
  flying: null,
};

export function BucketProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(bucketReducer, undefined, createInitialState);
  const [ui, setUi] = useState<UiState>(INITIAL_UI);

  const patchUi = useEvent((patch: Partial<UiState>) => setUi((prev) => ({ ...prev, ...patch })));
  const { playNeed, playWant, playLetGo } = useBucketSounds(ui.muted);

  /** Pulse a card for 1s after its balance moves. */
  const pulse = useEvent((bucketId: string) => {
    patchUi({ justUpdatedId: bucketId });
    window.setTimeout(() => patchUi({ justUpdatedId: null }), 1000);
  });

  const confirmPurchase = useEvent((data: PurchaseInput) => {
    dispatch({
      type: "CONFIRM_PURCHASE",
      transaction: {
        id: crypto.randomUUID(),
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        intent: data.intent,
        timestamp: Date.now(),
        readinessTag: data.readinessTag ?? null,
      },
    });
    pulse(data.bucketId);
    if (data.intent === "need") playNeed();
    else playWant();
  });

  const sleepOnIt = useEvent((data: SleepInput) => {
    dispatch({
      type: "SLEEP_ON_IT",
      item: {
        id: crypto.randomUUID(),
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        createdAt: Date.now(),
        hoursLeft: 23,
        intent: data.intent ?? "want",
        readinessTag: data.readinessTag ?? null,
      },
    });
    patchUi({ tab: "pending" });
  });

  const confirmPending = useEvent((id: string) => {
    const item = state.pending.find((p) => p.id === id);
    if (!item) return;
    dispatch({ type: "REMOVE_PENDING", id });
    // The original tag and readiness survive the pause — the model needs both later.
    confirmPurchase({
      amount: item.amount,
      label: item.label,
      bucketId: item.bucketId,
      intent: item.intent,
      readinessTag: item.readinessTag,
    });
  });

  /**
   * The emotional payload of the product. The choreography below is load-bearing:
   * coin leaves at once, tab flips at 100ms, the money lands at 720ms alongside the
   * pulse and the sound. Changing these numbers changes how the moment feels.
   */
  const letItGo = useEvent((id: string, sourceRect?: DOMRect) => {
    const item = state.pending.find((p) => p.id === id);
    if (!item) return;

    const savingsEl = document.querySelector<HTMLElement>(
      `[data-bucket-id="${SAVINGS_BUCKET_ID}"]`,
    );
    const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const from = sourceRect
      ? { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 }
      : fallback;
    const target = savingsEl?.getBoundingClientRect();
    const to = target
      ? { x: target.left + target.width / 2, y: target.top + target.height / 2 }
      : fallback;

    dispatch({ type: "REMOVE_PENDING", id });
    patchUi({ flying: { key: Date.now(), amount: item.amount, from, to } });

    window.setTimeout(() => patchUi({ tab: "buckets" }), 100);
    window.setTimeout(() => {
      dispatch({ type: "CREDIT_SAVINGS", amount: item.amount });
      patchUi({ flying: null });
      pulse(SAVINGS_BUCKET_ID);
      playLetGo();
    }, 720);

    toast("Let it go", {
      description: `${formatCurrency(item.amount)} → Savings`,
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          dispatch({ type: "DEBIT_SAVINGS", amount: item.amount });
          dispatch({ type: "RESTORE_PENDING", item });
          patchUi({ tab: "pending" });
        },
      },
    });
  });

  const createParentRequest = useEvent(
    (data: { amount: number; label: string; bucketId: string }) => {
      dispatch({
        type: "PARENT_REQUEST_CREATE",
        request: {
          id: crypto.randomUUID(),
          amount: data.amount,
          label: data.label,
          bucketId: data.bucketId,
          status: "pending",
          createdAt: Date.now(),
        },
      });
    },
  );

  const approveRequest = useEvent((id: string) => {
    const request = state.parentRequests.find((r) => r.id === id);
    if (!request) return;
    dispatch({ type: "PARENT_REQUEST_RESOLVE", id, status: "approved" });
    confirmPurchase({
      amount: request.amount,
      label: request.label,
      bucketId: request.bucketId,
      intent: "want",
    });
  });

  const denyRequest = useEvent((id: string) => {
    dispatch({ type: "PARENT_REQUEST_RESOLVE", id, status: "denied" });
  });

  const createBucket = useEvent((name: string, amount: number) => {
    dispatch({
      type: "CREATE_BUCKET",
      bucket: {
        id: crypto.randomUUID(),
        name,
        balance: amount,
        limit: null,
        ownerType: "self",
        iconKey: DEFAULT_BUCKET_ICON_KEY,
        accent: DEFAULT_BUCKET_ACCENT,
      },
    });
  });

  const setChildLimit = useEvent((value: string) => {
    const n = parseFloat(value);
    dispatch({ type: "SET_CHILD_LIMIT", limit: isNaN(n) || n <= 0 ? null : n });
  });

  const setTrip = useEvent((trip: Trip | null) => dispatch({ type: "SET_TRIP", trip }));

  const completeTrip = useEvent((checkedTotal: number) => {
    const trip = state.trip;
    if (!trip) return;
    const checked = trip.items.filter((i) => i.checked && i.price > 0);
    if (checked.length === 0) return;
    const bucket = state.buckets.find((b) => b.id === trip.bucketId);
    const label =
      checked.length === 1
        ? checked[0].name
        : `${bucket?.name ?? "Trip"} · ${checked.length} items`;

    confirmPurchase({
      amount: checkedTotal,
      label,
      bucketId: trip.bucketId,
      intent: "need",
      readinessTag: null,
    });
    dispatch({ type: "SET_TRIP", trip: null });
    patchUi({ tripOpen: false });
    toast("Trip complete", {
      description: `${formatCurrency(checkedTotal)} from ${bucket?.name ?? "bucket"}`,
      duration: 4000,
    });
  });

  const resetAll = useEvent(() => {
    dispatch({ type: "RESET" });
    setUi((prev) => ({ ...INITIAL_UI, muted: prev.muted, parentMode: prev.parentMode }));
  });

  const actions = useMemo<BucketActions>(
    () => ({
      confirmPurchase,
      sleepOnIt,
      confirmPending,
      letItGo,
      createParentRequest,
      approveRequest,
      denyRequest,
      createBucket,
      setChildLimit,
      setTrip,
      completeTrip,
      resetAll,
      setTab: (tab) => patchUi({ tab }),
      setPurchaseOpen: (purchaseOpen) => patchUi({ purchaseOpen }),
      setNewBucketOpen: (newBucketOpen) => patchUi({ newBucketOpen }),
      setTripOpen: (tripOpen) => patchUi({ tripOpen }),
      setScanning: (scanning) => patchUi({ scanning }),
      setParentMode: (parentMode) => patchUi({ parentMode }),
      toggleMuted: () => setUi((prev) => ({ ...prev, muted: !prev.muted })),
      setPrefill: (prefill) => patchUi({ prefill }),
    }),
    // Every entry is a useEvent callback, so this object is built once and never changes
    // identity. Consumers can hold it indefinitely without going stale.
    [
      confirmPurchase,
      sleepOnIt,
      confirmPending,
      letItGo,
      createParentRequest,
      approveRequest,
      denyRequest,
      createBucket,
      setChildLimit,
      setTrip,
      completeTrip,
      resetAll,
      patchUi,
    ],
  );

  const value = useMemo(() => ({ ...state, ui }), [state, ui]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={value}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useBucketState() {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useBucketState must be used inside <BucketProvider>");
  return ctx;
}

export function useBucketActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useBucketActions must be used inside <BucketProvider>");
  return ctx;
}
