import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { formatCurrency } from "@/lib/bucket-store";
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
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { TripPlanner } from "@/components/bucket/TripPlanner";
import { parseReceipt } from "@/lib/receipt-ocr";
import { DemoOverlay } from "@/components/bucket/DemoOverlay";
import { BucketProvider, useBucketActions, useBucketState } from "@/lib/bucket/provider";
import { useDemo } from "@/lib/bucket/use-demo";
import { loadBucketState } from "@/lib/bucket/server-fns";

export const Route = createFileRoute("/")({
  // Runs on the server for a cold load, so the page arrives already populated.
  loader: () => loadBucketState(),
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
  component: IndexRoute,
});

function IndexRoute() {
  const loaded = Route.useLoaderData();
  return (
    <BucketProvider initialState={loaded}>
      <Index />
    </BucketProvider>
  );
}

function Index() {
  const {
    buckets,
    startingBalances,
    transactions,
    pending,
    parentRequests,
    savedByPause,
    trip,
    ui,
  } = useBucketState();
  const actions = useBucketActions();
  const demo = useDemo();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const total = useMemo(() => buckets.reduce((s, b) => s + b.balance, 0), [buckets]);
  const kidsBucket = buckets.find((b) => b.ownerType === "child");
  const recent = transactions.slice(0, 5);

  const handleReceiptFile = async (file: File) => {
    actions.setScanning(true);
    try {
      const parsed = await parseReceipt(file);
      const lowConfidence = parsed.confidence < 0.5 || parsed.total <= 0;
      actions.setPrefill({
        amount: parsed.total > 0 ? parsed.total : 0,
        label: parsed.merchant || "",
      });
      actions.setPurchaseOpen(true);
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
      actions.setPrefill({ amount: 0, label: "" });
      actions.setPurchaseOpen(true);
      toast("Scan failed", {
        description: "Enter the purchase manually.",
        duration: 4000,
      });
    } finally {
      actions.setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

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
              onClick={demo.play}
              disabled={demo.active}
              className="h-9 rounded-lg gap-1.5"
            >
              <PlayCircle className="h-4 w-4" />
              <span className="hidden sm:inline">{demo.active ? "Playing…" : "Play demo"}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={actions.toggleMuted}
              className="h-9 w-9 rounded-lg"
              aria-label={ui.muted ? "Unmute" : "Mute"}
            >
              {ui.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
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
              onClick={() => actions.setPurchaseOpen(true)}
              data-demo="new-purchase"
              className="h-12 rounded-xl px-5 text-base shadow-[0_2px_8px_oklch(0.52_0.11_165/0.25)]"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              New purchase
            </Button>
            <Button
              variant="outline"
              onClick={() => actions.setNewBucketOpen(true)}
              className="h-12 rounded-xl px-4"
            >
              New bucket
            </Button>
            <Button
              variant="outline"
              onClick={() => actions.setTripOpen(true)}
              className="h-12 rounded-xl px-4 gap-1.5"
            >
              <ShoppingCart className="h-4 w-4" />
              {trip && trip.items.length > 0 ? "Resume trip" : "Plan a trip"}
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={ui.scanning}
              className="h-12 rounded-xl px-4 gap-1.5"
            >
              {ui.scanning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ScanLine className="h-4 w-4" />
              )}
              {ui.scanning ? "Reading…" : "Scan receipt"}
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
            onClick={() => actions.setTripOpen(true)}
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

        {/* Tabs: Buckets / Pending / Family */}
        <section className="mt-10">
          <div className="inline-flex items-center gap-1 rounded-xl bg-secondary p-1">
            <TabBtn active={ui.tab === "buckets"} onClick={() => actions.setTab("buckets")}>
              Buckets
            </TabBtn>
            <TabBtn active={ui.tab === "pending"} onClick={() => actions.setTab("pending")}>
              Pending
              {pending.length > 0 && (
                <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {pending.length}
                </span>
              )}
            </TabBtn>
            <TabBtn active={ui.tab === "family"} onClick={() => actions.setTab("family")}>
              Family
              {parentRequests.some((r) => r.status === "pending") && (
                <span className="ml-1.5 inline-flex h-2 w-2 rounded-full bg-primary" />
              )}
            </TabBtn>
          </div>

          <motion.div
            key={ui.tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-4"
          >
            {ui.tab === "buckets" && (
              <div className="grid gap-3 sm:grid-cols-2">
                {buckets.map((b) => (
                  <BucketCard
                    key={b.id}
                    bucket={b}
                    startingBalance={startingBalances[b.id] ?? b.balance}
                    justUpdated={ui.justUpdatedId === b.id}
                  />
                ))}
              </div>
            )}
            {ui.tab === "pending" && (
              <PendingTray
                items={pending}
                buckets={buckets}
                onConfirm={actions.confirmPending}
                onLetGo={actions.letItGo}
              />
            )}
            {ui.tab === "family" && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold">Parent mode</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Set limits and review purchase requests from kids' buckets.
                      </p>
                    </div>
                    <Switch checked={ui.parentMode} onCheckedChange={actions.setParentMode} />
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80 italic">
                    Demo only — this toggle is not a real parental control. In production, parent
                    mode would be gated behind a PIN or an authenticated parent account with
                    server-enforced roles.
                  </p>
                  {ui.parentMode && kidsBucket && (
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
                          onChange={(e) => actions.setChildLimit(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
                {ui.parentMode && (
                  <ParentInbox
                    requests={parentRequests}
                    buckets={buckets}
                    onApprove={actions.approveRequest}
                    onDeny={actions.denyRequest}
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
        open={ui.purchaseOpen}
        onOpenChange={actions.setPurchaseOpen}
        buckets={buckets}
        startingBalances={startingBalances}
        onConfirm={actions.confirmPurchase}
        onSleepOnIt={actions.sleepOnIt}
        onParentRequest={actions.createParentRequest}
        prefill={ui.prefill}
      />
      <NewBucketModal
        open={ui.newBucketOpen}
        onOpenChange={actions.setNewBucketOpen}
        onCreate={actions.createBucket}
      />
      <TripPlanner
        open={ui.tripOpen}
        onOpenChange={actions.setTripOpen}
        buckets={buckets}
        trip={trip}
        startingBalances={startingBalances}
        onTripChange={actions.setTrip}
        onComplete={actions.completeTrip}
        onDiscard={() => actions.setTrip(null)}
      />

      {/* Flying coin layer — money moving from pending into Savings */}
      <AnimatePresence>
        {ui.flying && (
          <motion.div
            key={ui.flying.key}
            initial={{
              left: ui.flying.from.x,
              top: ui.flying.from.y,
              scale: 1,
              opacity: 0,
            }}
            animate={{
              left: ui.flying.to.x,
              top: ui.flying.to.y,
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
              +{formatCurrency(ui.flying.amount)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <DemoOverlay
        active={demo.active}
        step={demo.step}
        total={demo.total}
        caption={demo.caption}
        targetSelector={demo.target}
        paused={demo.paused}
        speed={demo.speed}
        onSpeedChange={demo.setSpeed}
        onPauseToggle={demo.togglePaused}
        onExit={demo.exit}
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
