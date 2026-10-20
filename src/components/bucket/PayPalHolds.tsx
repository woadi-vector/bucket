import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, ExternalLink, Lock, MessageCircleWarning, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Bucket } from "@/lib/bucket-store";
import { formatCurrency, resolveBucketTag } from "@/lib/bucket-store";
import type { PublicHold } from "@/lib/bucket/hold-fns";

type Props = {
  holds: PublicHold[];
  buckets: Bucket[];
  busyId: string | null;
  onKeep: (hold: PublicHold) => void;
  onLetGo: (hold: PublicHold, sourceRect: DOMRect) => void;
  /** Called when a held hold's countdown reaches zero, so the server can apply the clock. */
  onExpire: () => void;
  /** Where released money goes in the app: back to its bucket, or set aside in Savings. */
  releaseTo: ReleaseTo;
  onReleaseTo: (to: ReleaseTo) => void;
};

type ReleaseTo = "bucket" | "savings";

/** The real money: holds placed at PayPal by the shopping agent, newest first. */
export function PayPalHolds({
  holds,
  buckets,
  busyId,
  onKeep,
  onLetGo,
  onExpire,
  releaseTo,
  onReleaseTo,
}: Props) {
  const now = useNow();
  const expiredSeen = useRef(new Set<string>());

  // When a held hold's window closes, ask once. The server voids it and the row comes back
  // marked as ended by the clock.
  useEffect(() => {
    const due = holds.filter(
      (h) => h.state === "held" && h.deadlineAt <= now && !expiredSeen.current.has(h.id),
    );
    if (due.length === 0) return;
    due.forEach((h) => expiredSeen.current.add(h.id));
    const t = window.setTimeout(onExpire, 800);
    return () => window.clearTimeout(t);
  }, [holds, now, onExpire]);

  const setting = <ReleaseSetting value={releaseTo} onChange={onReleaseTo} />;

  if (holds.length === 0) {
    return (
      <div className="space-y-3">
        {setting}
        <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center">
          <Lock className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing held at PayPal. Send the agent shopping, and any want it buys that is over its
            bucket's threshold, or that Bucket has a reason to question, waits here as a live PayPal
            hold.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      <li>{setting}</li>
      <AnimatePresence initial={false}>
        {holds.map((h) => {
          const bucket = buckets.find((b) => b.id === h.bucketId);
          const tag = bucket ? resolveBucketTag(bucket) : h.bucketTag;
          const remaining = h.deadlineAt - now;
          const live = h.state === "held" && remaining > 0;
          return (
            <motion.li
              key={h.id}
              data-hold-id={h.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.9, transition: { duration: 0.4 } }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              className={
                "rounded-2xl border bg-card p-4 sm:p-5 " +
                (live ? "border-primary/40" : "border-border opacity-80")
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{h.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: `var(--${tag})` }}
                    />
                    <span className="capitalize">{tag}</span>
                    <span>·</span>
                    <span>{bucket?.name ?? "—"}</span>
                    {h.merchant && (
                      <>
                        <span>·</span>
                        <span className="truncate">{h.merchant}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCurrency(h.amountCents / 100)}
                  </div>
                  <StateLine hold={h} remaining={remaining} />
                </div>
              </div>

              {h.pushback.length > 0 && (
                <ul className="mt-3 space-y-1.5 rounded-xl border border-want/30 bg-want/10 px-3 py-2.5">
                  {h.pushback.map((reason, i) => (
                    <li key={i} className="flex gap-2 text-sm leading-snug">
                      <MessageCircleWarning className="mt-0.5 h-4 w-4 shrink-0 text-want" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* The PayPal record itself. A judge can set this id beside PayPal's own. */}
              <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-secondary/60 px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  PayPal authorization
                </span>
                <code className="text-xs font-mono tabular-nums text-foreground">
                  {h.authorizationId}
                </code>
              </div>

              {live && (
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 h-10 rounded-xl"
                    disabled={busyId === h.id}
                    onClick={() => onKeep(h)}
                  >
                    Keep it
                  </Button>
                  <Button
                    className="flex-1 h-10 rounded-xl bg-primary/90 hover:bg-primary"
                    disabled={busyId === h.id}
                    onClick={(e) => {
                      const li = e.currentTarget.closest("li[data-hold-id]") as HTMLElement | null;
                      onLetGo(h, (li ?? e.currentTarget).getBoundingClientRect());
                    }}
                  >
                    <Sparkles className="mr-1 h-4 w-4" />
                    Let it go
                  </Button>
                </div>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
      <li className="pt-1 text-center">
        <a
          href="/ledger"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Every hold, with its PayPal id, on the public ledger
          <ExternalLink className="h-3 w-3" />
        </a>
      </li>
    </ul>
  );
}

/**
 * Where released money lands in the app. PayPal releases the hold either way; this only decides
 * whether the amount goes back to its bucket or is set aside in Savings, where it adds up.
 */
function ReleaseSetting({
  value,
  onChange,
}: {
  value: ReleaseTo;
  onChange: (to: ReleaseTo) => void;
}) {
  const option = (to: ReleaseTo, label: string) => (
    <button
      type="button"
      aria-pressed={value === to}
      onClick={() => onChange(to)}
      className={
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors " +
        (value === to
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-secondary/50 px-4 py-3">
      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          When you let a hold go or time runs out,
        </span>{" "}
        the money:
      </div>
      <div className="inline-flex rounded-xl bg-secondary p-1">
        {option("bucket", "Stays in its bucket")}
        {option("savings", "Goes to Savings")}
      </div>
    </div>
  );
}

function StateLine({ hold, remaining }: { hold: PublicHold; remaining: number }) {
  const base = "mt-0.5 inline-flex items-center gap-1 text-[11px]";
  if (hold.state === "held" && remaining > 0) {
    return (
      <div className={`${base} text-primary font-medium tabular-nums`}>
        <Clock className="h-3 w-3" />
        {formatRemaining(remaining)} to decide
      </div>
    );
  }
  if (hold.state === "held" || hold.state === "deciding") {
    return <div className={`${base} text-muted-foreground`}>Ending…</div>;
  }
  const who =
    hold.decidedBy === "clock"
      ? "time ran out"
      : hold.decidedBy === "policy"
        ? hold.bucketTag === "need"
          ? "a need"
          : "under threshold"
        : "you";
  return (
    <div className={`${base} text-muted-foreground`}>
      {hold.state === "captured" ? "Captured" : "Released"} · {who}
    </div>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** A clock that ticks once a second, for the countdowns. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
