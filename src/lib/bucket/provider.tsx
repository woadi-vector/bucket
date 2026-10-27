import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  DEFAULT_BUCKET_ACCENT,
  DEFAULT_BUCKET_ICON_KEY,
  PurchaseVerdict,
  ReadinessTag,
  SAVINGS_BUCKET_ID,
  Trip,
  formatCurrency,
} from "@/lib/bucket-store";
import { useBucketSounds } from "@/lib/use-bucket-sounds";
import { useEvent } from "@/lib/use-event";
import { bucketReducer, createInitialState, type BucketState } from "./reducer";
import { saveBucketState } from "./server-fns";
import { requestReconsideration, requestVerdict } from "./verdict-fns";

/** How long to wait after the last change before persisting. */
const SAVE_DEBOUNCE_MS = 800;

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
  /** Transaction whose contested verdict is being shown. Null when there is no argument. */
  retractionFor: string | null;
};

/** A verdict the purchase flow already has in hand when it commits the purchase. */
export type SettledVerdict = {
  verdict: PurchaseVerdict;
  /** Open the card afterwards, so the person can answer the question it asked. */
  openArgument?: boolean;
};

type PurchaseInput = {
  amount: number;
  label: string;
  bucketId: string;
  intent: "want" | "need";
  readinessTag?: ReadinessTag | null;
};

/** What the engine needs to judge one purchase, in the app's own vocabulary. */
type VerdictSubject = {
  amount: number;
  label: string;
  bucketId: string;
  intent: "want" | "need";
  readinessTag: ReadinessTag | null;
};

type SleepInput = {
  amount: number;
  label: string;
  bucketId: string;
  intent?: "want" | "need";
  readinessTag?: ReadinessTag | null;
};

export type BucketActions = {
  /**
   * Log a purchase.
   *
   * `settled` carries a verdict the purchase flow already obtained and showed. When it is
   * present no second call is made: the argument has been had, and asking again could return
   * a different answer than the one the person just decided about.
   */
  confirmPurchase: (data: PurchaseInput, settled?: SettledVerdict) => void;
  /**
   * Ask about a purchase before it is made, for the flow to show in time.
   *
   * Resolves to null when nothing usable came back. Never dispatches.
   */
  previewVerdict: (subject: {
    amount: number;
    label: string;
    intent: "want" | "need";
    readinessTag: ReadinessTag | null;
  }) => Promise<PurchaseVerdict | null>;
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
  /** Accept Bucket's second thought: the money goes back and the item waits in the tray. */
  retractToTray: (transactionId: string) => void;
  /** Keep your own call. Both the verdict and this decision are recorded. */
  overrideVerdict: (transactionId: string) => void;
  /** Close the argument without answering it. It stays on the transaction. */
  dismissRetraction: () => void;
  /**
   * Clear a bucket's deficit by moving money out of one that has it.
   *
   * Always the person's choice and never prompted by a model. Nothing calls this on their
   * behalf, and leaving a bucket negative is a supported outcome.
   */
  coverBucket: (fromBucketId: string, toBucketId: string, amount: number) => void;
  /**
   * Answer Bucket's question and let the expensive tier decide whether it holds.
   *
   * Resolves when the answer has been attached, so the card can show that it is waiting.
   * Always optional: ignoring the question and overriding the verdict outright are both
   * supported outcomes and neither is treated as worse than answering.
   */
  explainVerdict: (transactionId: string, explanation: string) => Promise<void>;
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
  retractionFor: null,
};

export function BucketProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  /** Server-loaded state. Present from the first render, so the hero number never animates on load. */
  initialState?: BucketState;
}) {
  const [state, dispatch] = useReducer(
    bucketReducer,
    initialState,
    (s) => s ?? createInitialState(),
  );
  const [ui, setUi] = useState<UiState>(INITIAL_UI);

  // Persist after the state settles. The first run is skipped: it would just write back
  // what the loader handed us.
  const skipNextSave = useRef(true);
  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void saveBucketState({ data: state }).catch((error) => {
        // A failed save must never interrupt the person using the app.
        console.error("[bucket] could not persist state", error);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [state]);

  const patchUi = useEvent((patch: Partial<UiState>) => setUi((prev) => ({ ...prev, ...patch })));
  const { playNeed, playWant, playLetGo } = useBucketSounds(ui.muted);

  /** Pulse a card for 1s after its balance moves. */
  const pulse = useEvent((bucketId: string) => {
    patchUi({ justUpdatedId: bucketId });
    window.setTimeout(() => patchUi({ justUpdatedId: null }), 1000);
  });

  /**
   * Asks the engine to judge a tag, and attaches the answer whenever it arrives.
   *
   * Deliberately **not** awaited by its callers. Measured latency is ~2.1s for the cheap
   * tier and ~3.6s for the expensive one, so awaiting this anywhere in the purchase flow
   * would put multiple seconds inside a screen designed as a half-second pause — the exact
   * beat the product exists to create. The verdict lands when it lands; if the item is gone
   * by then the reducer ignores it.
   */
  const requestVerdictFor = useEvent(
    (subjectId: string, subject: VerdictSubject, kind: "transaction" | "pending") => {
      const bucketName = (id: string) => state.buckets.find((b) => b.id === id)?.name;

      const history = state.transactions.slice(0, 20).map((t) => ({
        amount: t.amount,
        label: t.label,
        intent: t.intent,
        readinessTag: t.readinessTag,
        timestamp: t.timestamp,
        bucketName: bucketName(t.bucketId),
      }));

      const purchase = {
        amount: subject.amount,
        label: subject.label,
        intent: subject.intent,
        readinessTag: subject.readinessTag,
        bucketName: bucketName(subject.bucketId),
      };

      void requestVerdict({ data: { purchase, history } })
        .then((verdict) => {
          dispatch({
            type: "ATTACH_VERDICT",
            subjectId,
            // Everything the browser is allowed to see, rather than a subset of it. An
            // earlier version of this listed four fields by hand, which silently dropped the
            // question Bucket wanted to ask, the id that lets an answer be attached to the
            // right exchange, and the model attribution. All three were produced, sent, and
            // thrown away here, so the features that depended on them could not work and
            // nothing anywhere reported a fault.
            verdict: {
              agrees: verdict.agrees,
              verdict: verdict.verdict,
              confidence: verdict.confidence,
              reasoning: verdict.reasoning,
              ...(verdict.cached ? { cached: true } : {}),
              ...(verdict.withheld ? { withheld: true } : {}),
              ...(verdict.question ? { question: verdict.question } : {}),
              ...(verdict.exchangeId ? { exchangeId: verdict.exchangeId } : {}),
              ...(verdict.attribution ? { attribution: verdict.attribution } : {}),
            },
          });

          // Only a logged purchase earns the interruption. A tray item is already paused,
          // so its argument is shown on the card rather than in front of the person.
          // A cached verdict always agrees, but check explicitly: nothing canned may ever
          // raise an argument in front of someone.
          //
          // `withheld` is checked for its own sake rather than relying on the empty
          // `reasoning` that comes with it. The two travel together today, and a silence
          // that depended on that staying true would be one refactor from breaking.
          if (
            !verdict.agrees &&
            !verdict.cached &&
            !verdict.withheld &&
            verdict.reasoning &&
            kind === "transaction"
          ) {
            patchUi({ retractionFor: subjectId });
          }
        })
        .catch((error) => {
          // Silence is a valid outcome: the engine advises, so no answer means no argument.
          console.error("[bucket] verdict request failed", error);
        });
    },
  );

  /**
   * Asks the engine about a purchase that has not been made yet.
   *
   * The same screening call as {@link requestVerdictFor}, started while the person is still
   * choosing a bucket rather than after the money has moved. Nothing is dispatched: the
   * answer goes back to the caller, which decides whether it arrived in time to be worth
   * showing before the purchase commits.
   *
   * `bucketName` is deliberately absent. It is optional in the engine's request and the
   * prompt simply drops that line, which is what makes starting early possible at all: the
   * label, the tag and the person's own history carry the judgement, and the bucket is
   * context rather than evidence.
   *
   * Resolves to null on any failure. A preview that cannot be had is not an error worth
   * showing anyone, and the ordinary post-purchase path still runs behind it.
   */
  const previewVerdict = useEvent(
    async (subject: {
      amount: number;
      label: string;
      intent: "want" | "need";
      readinessTag: ReadinessTag | null;
    }): Promise<PurchaseVerdict | null> => {
      const bucketName = (id: string) => state.buckets.find((b) => b.id === id)?.name;
      const history = state.transactions.slice(0, 20).map((t) => ({
        amount: t.amount,
        label: t.label,
        intent: t.intent,
        readinessTag: t.readinessTag,
        timestamp: t.timestamp,
        bucketName: bucketName(t.bucketId),
      }));

      try {
        const verdict = await requestVerdict({
          data: {
            purchase: {
              amount: subject.amount,
              label: subject.label,
              intent: subject.intent,
              readinessTag: subject.readinessTag,
            },
            history,
          },
        });

        return {
          agrees: verdict.agrees,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          ...(verdict.cached ? { cached: true } : {}),
          ...(verdict.withheld ? { withheld: true } : {}),
          ...(verdict.question ? { question: verdict.question } : {}),
          ...(verdict.exchangeId ? { exchangeId: verdict.exchangeId } : {}),
          ...(verdict.attribution ? { attribution: verdict.attribution } : {}),
        };
      } catch (error) {
        console.error("[bucket] verdict preview failed", error);
        return null;
      }
    },
  );

  const confirmPurchase = useEvent((data: PurchaseInput, settled?: SettledVerdict) => {
    const id = crypto.randomUUID();
    dispatch({
      type: "CONFIRM_PURCHASE",
      transaction: {
        id,
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        intent: data.intent,
        timestamp: Date.now(),
        readinessTag: data.readinessTag ?? null,
        verdict: settled?.verdict ?? null,
      },
    });
    pulse(data.bucketId);
    if (data.intent === "need") playNeed();
    else playWant();

    // An answer the purchase flow already has. Asking again would spend a second call on a
    // question that has been answered and could come back differently, which would leave the
    // person looking at an argument other than the one they just decided about.
    if (settled?.verdict) {
      if (settled.openArgument) patchUi({ retractionFor: id });
      return;
    }

    // Fire and forget — see requestVerdictFor. Nothing below waits on this.
    requestVerdictFor(
      id,
      {
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        intent: data.intent,
        readinessTag: data.readinessTag ?? null,
      },
      "transaction",
    );
  });

  const sleepOnIt = useEvent((data: SleepInput) => {
    const id = crypto.randomUUID();
    const intent = data.intent ?? "want";
    dispatch({
      type: "SLEEP_ON_IT",
      item: {
        id,
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        createdAt: Date.now(),
        hoursLeft: 23,
        intent,
        readinessTag: data.readinessTag ?? null,
        verdict: null,
      },
    });
    patchUi({ tab: "pending" });

    // The tray is a 24h window, so there is all the time in the world for this to land.
    requestVerdictFor(
      id,
      {
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        intent,
        readinessTag: data.readinessTag ?? null,
      },
      "pending",
    );
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

  const retractToTray = useEvent((transactionId: string) => {
    const tx = state.transactions.find((t) => t.id === transactionId);
    if (!tx) return;

    dispatch({
      type: "RETRACT_TO_TRAY",
      transactionId,
      pendingId: crypto.randomUUID(),
      createdAt: Date.now(),
    });
    patchUi({ retractionFor: null, tab: "pending" });

    toast("Pulled back", {
      description: `${formatCurrency(tx.amount)} returned to your bucket — it can wait.`,
      duration: 5000,
    });
  });

  const overrideVerdict = useEvent((transactionId: string) => {
    dispatch({ type: "OVERRIDE_VERDICT", transactionId });
    patchUi({ retractionFor: null });
  });

  const dismissRetraction = useEvent(() => patchUi({ retractionFor: null }));

  /**
   * The person answered Bucket's question.
   *
   * Awaited by its caller, unlike the first verdict. The difference is that someone is
   * sitting in front of this one having just typed something: a result that landed silently
   * whenever it felt like it would read as the app ignoring them. The card shows a waiting
   * state and this resolves it.
   *
   * A failure accepts the explanation rather than leaving the argument standing. Holding a
   * verdict because a network call fell over would mean Bucket wins by default, and nothing
   * about a dropped request is evidence that the person was wrong.
   */
  const explainVerdict = useEvent(async (transactionId: string, explanation: string) => {
    const tx = state.transactions.find((t) => t.id === transactionId);
    if (!tx?.verdict) return;

    const bucketName = (id: string) => state.buckets.find((b) => b.id === id)?.name;
    const history = state.transactions
      .filter((t) => t.id !== transactionId)
      .slice(0, 20)
      .map((t) => ({
        amount: t.amount,
        label: t.label,
        intent: t.intent,
        readinessTag: t.readinessTag,
        timestamp: t.timestamp,
        bucketName: bucketName(t.bucketId),
      }));

    try {
      const settled = await requestReconsideration({
        data: {
          purchase: {
            amount: tx.amount,
            label: tx.label,
            intent: tx.intent,
            readinessTag: tx.readinessTag,
            bucketName: bucketName(tx.bucketId),
          },
          history,
          question: tx.verdict.question ?? "",
          explanation,
          priorVerdict: tx.verdict.verdict,
          ...(tx.verdict.exchangeId ? { exchangeId: tx.verdict.exchangeId } : {}),
        },
      });

      dispatch({
        type: "ATTACH_RECONSIDERATION",
        transactionId,
        verdict: {
          agrees: settled.agrees,
          verdict: settled.verdict,
          confidence: settled.confidence,
          reasoning: settled.reasoning,
          // The whole point of the second pass. Derived server-side from the new verdict,
          // never taken from the model, because it decides which of two opposite things the
          // person is told.
          explanationAccepted: settled.explanationAccepted ?? false,
          ...(settled.attribution ? { attribution: settled.attribution } : {}),
        },
      });
    } catch (error) {
      console.error("[bucket] reconsideration failed", error);
      dispatch({
        type: "ATTACH_RECONSIDERATION",
        transactionId,
        verdict: {
          agrees: true,
          verdict: tx.intent,
          confidence: 0,
          reasoning: "",
          explanationAccepted: true,
        },
      });
    }
  });

  const coverBucket = useEvent((fromBucketId: string, toBucketId: string, amount: number) => {
    const from = state.buckets.find((b) => b.id === fromBucketId);
    const to = state.buckets.find((b) => b.id === toBucketId);
    if (!from || !to) return;

    dispatch({
      type: "COVER_BUCKET",
      cover: {
        id: crypto.randomUUID(),
        amount,
        fromBucketId,
        toBucketId,
        timestamp: Date.now(),
      },
    });

    toast("Covered", {
      description: `${formatCurrency(amount)} moved from ${from.name} to ${to.name}.`,
      duration: 5000,
    });
  });

  const resetAll = useEvent(() => {
    dispatch({ type: "RESET" });
    setUi((prev) => ({ ...INITIAL_UI, muted: prev.muted, parentMode: prev.parentMode }));
  });

  const actions = useMemo<BucketActions>(
    () => ({
      confirmPurchase,
      previewVerdict,
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
      retractToTray,
      overrideVerdict,
      dismissRetraction,
      coverBucket,
      explainVerdict,
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
      previewVerdict,
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
      retractToTray,
      overrideVerdict,
      dismissRetraction,
      coverBucket,
      explainVerdict,
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
