import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bucket,
  PendingWant,
  ParentRequest,
  Transaction,
  ReadinessTag,
  initialBuckets,
  formatCurrency,
  SAVINGS_BUCKET_ID,
  DEFAULT_BUCKET_ICON,
  DEFAULT_BUCKET_ACCENT,
} from "@/lib/bucket-store";
import { BucketCard } from "@/components/bucket/BucketCard";
import { PurchaseFlow } from "@/components/bucket/PurchaseFlow";
import { NewBucketModal } from "@/components/bucket/NewBucketModal";
import { PendingTray } from "@/components/bucket/PendingTray";
import { HeroSaved } from "@/components/bucket/HeroSaved";
import { WantNeedRatio } from "@/components/bucket/WantNeedRatio";
import { ReadinessInsights } from "@/components/bucket/ReadinessInsights";
import { ParentInbox } from "@/components/bucket/ParentInbox";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Sparkles,
  Volume2,
  VolumeX,
  PlayCircle,
  ShoppingCart,
  ScanLine,
  Loader2,
} from "lucide-react";
import { useBucketSounds } from "@/lib/use-bucket-sounds";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { TripPlanner, Trip } from "@/components/bucket/TripPlanner";
import { parseReceipt } from "@/lib/receipt-ocr";
import { DemoOverlay } from "@/components/bucket/DemoOverlay";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bucket — Decide before you spend" },
      {
        name: "description",
        content:
          "A calm budgeting app that pauses you before each purchase to decide want vs. need and pick a bucket.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [startingBalances, setStartingBalances] = useState<Record<string, number>>(() =>
    Object.fromEntries(initialBuckets.map((b) => [b.id, b.balance])),
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pending, setPending] = useState<PendingWant[]>([]);
  const [parentRequests, setParentRequests] = useState<ParentRequest[]>([]);
  const [savedByPause, setSavedByPause] = useState(0);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [tripOpen, setTripOpen] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleReceiptFile = async (file: File) => {
    setScanning(true);
    try {
      const parsed = await parseReceipt(file);
      const lowConfidence = parsed.confidence < 0.5 || parsed.total <= 0;
      setDemoPrefill({
        amount: parsed.total > 0 ? parsed.total : 0,
        label: parsed.merchant || "",
      });
      setPurchaseOpen(true);
      if (lowConfidence) {
        toast("Couldn't read clearly", {
          description: "Fill in what's right — your call.",
          duration: 4000,
        });
      } else {
        toast("Receipt scanned", {
          description: `${parsed.merchant} · $${parsed.total.toFixed(2)}`,
          duration: 3000,
        });
      }
    } catch {
      // Hard failure → still drop into manual entry, don't dead-end.
      setDemoPrefill({ amount: 0, label: "" });
      setPurchaseOpen(true);
      toast("Scan failed", {
        description: "Enter the purchase manually.",
        duration: 4000,
      });
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  const [parentMode, setParentMode] = useState(false);
  const [muted, setMuted] = useState(true);
  const [justUpdatedId, setJustUpdatedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"buckets" | "pending" | "family">("buckets");
  const [demoPrefill, setDemoPrefill] = useState<{
    amount: number;
    label: string;
    intent?: "want" | "need";
    bucketId?: string;
  } | null>(null);
  const [demoActive, setDemoActive] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [demoPaused, setDemoPaused] = useState(false);
  const [demoSpeed, setDemoSpeed] = useState(1);
  const [flying, setFlying] = useState<{
    key: number;
    amount: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);

  const { playNeed, playWant, playLetGo } = useBucketSounds(muted);

  const total = useMemo(() => buckets.reduce((s, b) => s + b.balance, 0), [buckets]);

  const handleConfirm = (data: {
    amount: number;
    label: string;
    bucketId: string;
    intent: "want" | "need";
    readinessTag?: ReadinessTag | null;
  }) => {
    setBuckets((prev) =>
      prev.map((b) => (b.id === data.bucketId ? { ...b, balance: b.balance - data.amount } : b)),
    );
    setTransactions((prev) => [
      {
        id: crypto.randomUUID(),
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        intent: data.intent,
        timestamp: Date.now(),
        readinessTag: data.readinessTag ?? null,
      },
      ...prev,
    ]);
    setJustUpdatedId(data.bucketId);
    setTimeout(() => setJustUpdatedId(null), 1000);
    if (data.intent === "need") playNeed();
    else playWant();
  };

  const handleSleepOnIt = (data: {
    amount: number;
    label: string;
    bucketId: string;
    readinessTag?: ReadinessTag | null;
  }) => {
    setPending((prev) => [
      {
        id: crypto.randomUUID(),
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        createdAt: Date.now(),
        hoursLeft: 23,
      },
      ...prev,
    ]);
    setTab("pending");
  };

  const confirmPending = (id: string) => {
    const p = pending.find((x) => x.id === id);
    if (!p) return;
    setPending((prev) => prev.filter((x) => x.id !== id));
    handleConfirm({ amount: p.amount, label: p.label, bucketId: p.bucketId, intent: "want" });
  };

  const letItGo = (id: string, sourceRect?: DOMRect) => {
    const p = pending.find((x) => x.id === id);
    if (!p) return;

    // Resolve source/target points for the flying coin
    const savingsEl = document.querySelector<HTMLElement>(
      `[data-bucket-id="${SAVINGS_BUCKET_ID}"]`,
    );
    const fallback = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    const from = sourceRect
      ? { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 }
      : fallback;
    const target = savingsEl?.getBoundingClientRect();
    const to = target
      ? { x: target.left + target.width / 2, y: target.top + target.height / 2 }
      : fallback;

    // Remove pending item immediately (it should leave the list)
    setPending((prev) => prev.filter((x) => x.id !== id));

    // Fire coin
    setFlying({ key: Date.now(), amount: p.amount, from, to });

    // After the coin lands (~700ms): bump savings + saved counter + pulse + sound
    window.setTimeout(() => {
      setTab("buckets");
    }, 100);
    window.setTimeout(() => {
      setBuckets((prev) =>
        prev.map((b) => (b.id === SAVINGS_BUCKET_ID ? { ...b, balance: b.balance + p.amount } : b)),
      );
      setStartingBalances((prev) => ({
        ...prev,
        [SAVINGS_BUCKET_ID]: (prev[SAVINGS_BUCKET_ID] ?? 0) + p.amount,
      }));
      setJustUpdatedId(SAVINGS_BUCKET_ID);
      setSavedByPause((s) => s + p.amount);
      playLetGo();
      setFlying(null);
      window.setTimeout(() => setJustUpdatedId(null), 1000);
    }, 720);

    // Undo toast
    toast("Let it go", {
      description: `${formatCurrency(p.amount)} → Savings`,
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          // Reverse: take it back out of savings, restore pending item, decrement saved
          setBuckets((prev) =>
            prev.map((b) =>
              b.id === SAVINGS_BUCKET_ID ? { ...b, balance: b.balance - p.amount } : b,
            ),
          );
          setStartingBalances((prev) => ({
            ...prev,
            [SAVINGS_BUCKET_ID]: Math.max(0, (prev[SAVINGS_BUCKET_ID] ?? 0) - p.amount),
          }));
          setSavedByPause((s) => Math.max(0, s - p.amount));
          setPending((prev) => [p, ...prev]);
          setTab("pending");
        },
      },
    });
  };

  const handleParentRequest = (data: { amount: number; label: string; bucketId: string }) => {
    setParentRequests((prev) => [
      {
        id: crypto.randomUUID(),
        amount: data.amount,
        label: data.label,
        bucketId: data.bucketId,
        status: "pending",
        createdAt: Date.now(),
      },
      ...prev,
    ]);
  };

  const approveRequest = (id: string) => {
    const r = parentRequests.find((x) => x.id === id);
    if (!r) return;
    setParentRequests((prev) => prev.map((x) => (x.id === id ? { ...x, status: "approved" } : x)));
    handleConfirm({ amount: r.amount, label: r.label, bucketId: r.bucketId, intent: "want" });
  };

  const denyRequest = (id: string) => {
    setParentRequests((prev) => prev.map((x) => (x.id === id ? { ...x, status: "denied" } : x)));
  };

  const handleCreateBucket = (name: string, amount: number) => {
    const id = crypto.randomUUID();
    setBuckets((prev) => [
      ...prev,
      {
        id,
        name,
        balance: amount,
        limit: null,
        ownerType: "self",
        icon: DEFAULT_BUCKET_ICON,
        accent: DEFAULT_BUCKET_ACCENT,
      },
    ]);
    setStartingBalances((prev) => ({ ...prev, [id]: amount }));
  };

  const kidsBucket = buckets.find((b) => b.ownerType === "child");

  const setKidsLimit = (val: string) => {
    const n = parseFloat(val);
    setBuckets((prev) =>
      prev.map((b) =>
        b.ownerType === "child" ? { ...b, limit: isNaN(n) || n <= 0 ? null : n } : b,
      ),
    );
  };

  const recent = transactions.slice(0, 5);

  // -------- Scripted demo --------
  const resetDemoState = useCallback(() => {
    setBuckets(initialBuckets);
    setStartingBalances(Object.fromEntries(initialBuckets.map((b) => [b.id, b.balance])));
    setTransactions([]);
    setPending([]);
    setParentRequests([]);
    setSavedByPause(0);
    setTrip(null);
    setTripOpen(false);
    setNewBucketOpen(false);
    setPurchaseOpen(false);
    setDemoPrefill(null);
    setTab("buckets");
  }, []);

  type DemoStep = { caption: string; target?: string | null; delay: number; action?: () => void };
  const demoSteps = useMemo<DemoStep[]>(
    () => [
      {
        caption: "Three buckets to live from — Groceries, Dining, Savings.",
        target: `[data-bucket-id="b1"]`,
        delay: 2600,
        action: () => setTab("buckets"),
      },
      {
        caption: "Time to spend. Tap New purchase to start.",
        target: `[data-demo="new-purchase"]`,
        delay: 1900,
      },
      {
        caption: "$68 headphones — tagged a want, not a need.",
        target: null,
        delay: 2400,
        action: () => {
          setDemoPrefill({ amount: 68, label: "New headphones", intent: "want", bucketId: "b2" });
          setPurchaseOpen(true);
        },
      },
      {
        caption: "Sleep on it. Wants get a 23-hour pause.",
        target: null,
        delay: 1800,
        action: () => {
          setPurchaseOpen(false);
          setDemoPrefill(null);
          handleSleepOnIt({ amount: 68, label: "New headphones", bucketId: "b2" });
        },
      },
      {
        caption: "Pending tray — your future self decides.",
        target: `li[data-pending-id]`,
        delay: 2400,
        action: () => setTab("pending"),
      },
      {
        caption: "Let it go — money flies straight into Savings.",
        target: `[data-bucket-id="b4"]`,
        delay: 2800,
        action: () => {
          const li = document.querySelector<HTMLElement>("li[data-pending-id]");
          const id = li?.dataset.pendingId;
          if (id) letItGo(id, li?.getBoundingClientRect());
        },
      },
      {
        caption: "Saved by pause — every skipped want adds up.",
        target: `[data-demo="saved"]`,
        delay: 2600,
      },
      {
        caption: "Insights reveal the shape of your wanting.",
        target: `[data-demo="insights"]`,
        delay: 2800,
      },
      {
        caption: "Done. Replay anytime, at any speed.",
        target: null,
        delay: 1800,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const lastRunStepRef = useRef(0);
  useEffect(() => {
    if (!demoActive || demoPaused) return;
    if (demoStep < 1) return;
    if (demoStep > demoSteps.length) {
      setDemoActive(false);
      setDemoStep(0);
      lastRunStepRef.current = 0;
      return;
    }
    const step = demoSteps[demoStep - 1];
    if (lastRunStepRef.current !== demoStep) {
      lastRunStepRef.current = demoStep;
      step.action?.();
    }
    const ms = Math.max(400, step.delay / demoSpeed);
    const t = window.setTimeout(() => setDemoStep((s) => s + 1), ms);
    return () => window.clearTimeout(t);
  }, [demoActive, demoPaused, demoStep, demoSpeed, demoSteps]);

  const playDemo = useCallback(() => {
    if (demoActive) return;
    resetDemoState();
    lastRunStepRef.current = 0;
    setDemoSpeed(1);
    setDemoPaused(false);
    setDemoStep(1);
    setDemoActive(true);
  }, [demoActive, resetDemoState]);

  const exitDemo = useCallback(() => {
    setDemoActive(false);
    setDemoPaused(false);
    setDemoStep(0);
    lastRunStepRef.current = 0;
  }, []);

  const currentStep =
    demoActive && demoStep > 0 ? demoSteps[Math.min(demoStep, demoSteps.length) - 1] : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-5 pb-24 pt-10 sm:pt-14">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-xl bg-primary flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-base font-semibold tracking-tight">Bucket</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={playDemo}
              disabled={demoActive}
              className="h-9 rounded-lg gap-1.5"
            >
              <PlayCircle className="h-4 w-4" />
              <span className="hidden sm:inline">{demoActive ? "Playing…" : "Play demo"}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMuted((m) => !m)}
              className="h-9 w-9 rounded-lg"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        {/* Total balance */}
        <section className="mt-12 sm:mt-16">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Total balance</p>
          <h1 className="mt-2 text-5xl sm:text-6xl font-semibold tabular-nums tracking-tight">
            {formatCurrency(total)}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Cards made spending painless. We brought the pause back.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              onClick={() => setPurchaseOpen(true)}
              data-demo="new-purchase"
              className="h-12 rounded-xl px-5 text-base shadow-[0_2px_8px_oklch(0.52_0.11_165/0.25)]"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              New purchase
            </Button>
            <Button
              variant="outline"
              onClick={() => setNewBucketOpen(true)}
              className="h-12 rounded-xl px-4"
            >
              New bucket
            </Button>
            <Button
              variant="outline"
              onClick={() => setTripOpen(true)}
              className="h-12 rounded-xl px-4 gap-1.5"
            >
              <ShoppingCart className="h-4 w-4" />
              {trip && trip.items.length > 0 ? "Resume trip" : "Plan a trip"}
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={scanning}
              className="h-12 rounded-xl px-4 gap-1.5"
            >
              {scanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ScanLine className="h-4 w-4" />
              )}
              {scanning ? "Reading…" : "Scan receipt"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleReceiptFile(f);
              }}
            />
          </div>
        </section>

        {trip && trip.items.length > 0 && (
          <button
            type="button"
            onClick={() => setTripOpen(true)}
            className="mt-4 w-full rounded-2xl border border-primary/30 bg-accent/40 px-4 py-3 text-left transition-colors hover:bg-accent/60"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <ShoppingCart className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium truncate">
                  Trip in progress · {trip.items.length} item{trip.items.length === 1 ? "" : "s"}
                </span>
              </div>
              <span className="text-sm tabular-nums font-semibold text-foreground shrink-0">
                {formatCurrency(trip.items.reduce((s, i) => s + i.price, 0))}
              </span>
            </div>
          </button>
        )}

        {/* Hero saved + ratio */}
        <section className="mt-8 grid gap-3 sm:grid-cols-5">
          <div className="sm:col-span-3" data-demo="saved">
            <HeroSaved amount={savedByPause} />
          </div>
          <div className="sm:col-span-2">
            <WantNeedRatio transactions={transactions} />
          </div>
        </section>

        <div data-demo="insights">
          <ReadinessInsights transactions={transactions} savedByPause={savedByPause} />
        </div>

        {/* Tabs: Buckets / Pending */}
        <section className="mt-10">
          <div className="inline-flex items-center gap-1 rounded-xl bg-secondary p-1">
            <TabBtn active={tab === "buckets"} onClick={() => setTab("buckets")}>
              Buckets
            </TabBtn>
            <TabBtn active={tab === "pending"} onClick={() => setTab("pending")}>
              Pending
              {pending.length > 0 && (
                <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {pending.length}
                </span>
              )}
            </TabBtn>
            <TabBtn active={tab === "family"} onClick={() => setTab("family")}>
              Family
              {parentRequests.some((r) => r.status === "pending") && (
                <span className="ml-1.5 inline-flex h-2 w-2 rounded-full bg-primary" />
              )}
            </TabBtn>
          </div>

          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-4"
          >
            {tab === "buckets" && (
              <div className="grid gap-3 sm:grid-cols-2">
                {buckets.map((b) => (
                  <BucketCard
                    key={b.id}
                    bucket={b}
                    startingBalance={startingBalances[b.id] ?? b.balance}
                    justUpdated={justUpdatedId === b.id}
                  />
                ))}
              </div>
            )}
            {tab === "pending" && (
              <PendingTray
                items={pending}
                buckets={buckets}
                onConfirm={confirmPending}
                onLetGo={letItGo}
              />
            )}
            {tab === "family" && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold">Parent mode</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Set limits and review purchase requests from kids' buckets.
                      </p>
                    </div>
                    <Switch checked={parentMode} onCheckedChange={setParentMode} />
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80 italic">
                    Demo only — this toggle is not a real parental control. In production, parent
                    mode would be gated behind a PIN or an authenticated parent account with
                    server-enforced roles.
                  </p>
                  {parentMode && kidsBucket && (
                    <div className="mt-4 flex items-center justify-between gap-3 pt-4 border-t border-border">
                      <div>
                        <p className="text-sm font-medium">{kidsBucket.name} limit</p>
                        <p className="text-xs text-muted-foreground">
                          Soft cap before asking permission.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">$</span>
                        <Input
                          type="number"
                          inputMode="decimal"
                          className="h-10 w-28 rounded-lg"
                          placeholder="No limit"
                          value={kidsBucket.limit ?? ""}
                          onChange={(e) => setKidsLimit(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
                {parentMode && (
                  <ParentInbox
                    requests={parentRequests}
                    buckets={buckets}
                    onApprove={approveRequest}
                    onDeny={denyRequest}
                  />
                )}
              </div>
            )}
          </motion.div>
        </section>

        {/* Recent */}
        {recent.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
            <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-card overflow-hidden">
              {recent.map((t) => {
                const b = buckets.find((x) => x.id === t.bucketId);
                return (
                  <li key={t.id} className="flex items-center justify-between px-5 py-3.5">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{t.label}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: `var(--${t.intent})` }}
                        />
                        <span className="capitalize">{t.intent}</span>
                        <span>·</span>
                        <span>{b?.name ?? "—"}</span>
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums">
                      −{formatCurrency(t.amount)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <PurchaseFlow
        open={purchaseOpen}
        onOpenChange={setPurchaseOpen}
        buckets={buckets}
        startingBalances={startingBalances}
        onConfirm={handleConfirm}
        onSleepOnIt={handleSleepOnIt}
        onParentRequest={handleParentRequest}
        prefill={demoPrefill}
      />
      <NewBucketModal
        open={newBucketOpen}
        onOpenChange={setNewBucketOpen}
        onCreate={handleCreateBucket}
      />
      <TripPlanner
        open={tripOpen}
        onOpenChange={setTripOpen}
        buckets={buckets}
        trip={trip}
        startingBalances={startingBalances}
        onTripChange={setTrip}
        onComplete={(checkedTotal) => {
          if (!trip) return;
          const checked = trip.items.filter((i) => i.checked && i.price > 0);
          if (checked.length === 0) return;
          const bucket = buckets.find((b) => b.id === trip.bucketId);
          const label =
            checked.length === 1
              ? checked[0].name
              : `${bucket?.name ?? "Trip"} · ${checked.length} items`;
          handleConfirm({
            amount: checkedTotal,
            label,
            bucketId: trip.bucketId,
            intent: "need",
            readinessTag: null,
          });
          setTrip(null);
          setTripOpen(false);
          toast("Trip complete", {
            description: `${formatCurrency(checkedTotal)} from ${bucket?.name ?? "bucket"}`,
            duration: 4000,
          });
        }}
        onDiscard={() => setTrip(null)}
      />

      {/* Flying coin layer — money moving from pending into Savings */}
      <AnimatePresence>
        {flying && (
          <motion.div
            key={flying.key}
            initial={{
              left: flying.from.x,
              top: flying.from.y,
              scale: 1,
              opacity: 0,
            }}
            animate={{
              left: flying.to.x,
              top: flying.to.y,
              scale: 0.55,
              opacity: [0, 1, 1, 0.9],
            }}
            exit={{ opacity: 0 }}
            transition={{
              duration: 0.7,
              ease: [0.22, 1, 0.36, 1],
              opacity: { times: [0, 0.15, 0.85, 1], duration: 0.7 },
            }}
            style={{ position: "fixed", zIndex: 60, pointerEvents: "none" }}
            className="-translate-x-1/2 -translate-y-1/2"
          >
            <div className="rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold tabular-nums shadow-[0_8px_24px_oklch(0.52_0.11_165/0.45)]">
              +{formatCurrency(flying.amount)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <DemoOverlay
        active={demoActive}
        step={Math.min(demoStep, demoSteps.length)}
        total={demoSteps.length}
        caption={currentStep?.caption ?? ""}
        targetSelector={currentStep?.target ?? null}
        paused={demoPaused}
        speed={demoSpeed}
        onSpeedChange={setDemoSpeed}
        onPauseToggle={() => setDemoPaused((p) => !p)}
        onExit={exitDemo}
      />
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center px-3.5 h-9 rounded-lg text-sm font-medium transition-all " +
        (active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
