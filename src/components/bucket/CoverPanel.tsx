import { useState } from "react";
import { Bucket, formatCurrency, resolveBucketIcon } from "@/lib/bucket-store";
import { useBucketActions } from "@/lib/bucket/provider";
import { cn } from "@/lib/utils";

/**
 * What to do about a bucket that has gone past zero.
 *
 * Deliberately not a warning. There is no alert icon, no urgency, no count of days
 * underwater, and nothing here blocks or undoes a purchase that already happened. Bucket's
 * job at this point is finished: the picker showed `$0 → -$250` in red beside the other
 * buckets' balances before the money moved, which is where the cost was supposed to land.
 * This is only the arithmetic of fixing it, offered once and then left alone.
 *
 * "Leave it" is a real answer and the panel takes it without argument. A negative bucket is
 * an honest record of having bought something that fit nowhere, and a running tab is more
 * useful than a tidy zero reached by nagging. The card keeps showing the deficit either way.
 */
type Props = {
  buckets: Bucket[];
};

export function CoverPanel({ buckets }: Props) {
  const { coverBucket } = useBucketActions();
  /** Per-session, per-bucket. Dismissing hides the offer, never the deficit. */
  const [left, setLeft] = useState<string[]>([]);

  const underwater = buckets.filter((b) => b.balance < 0 && !left.includes(b.id));
  if (underwater.length === 0) return null;

  return (
    <div className="grid gap-3">
      {underwater.map((bucket) => {
        const deficit = -bucket.balance;
        // Only buckets with something in them, biggest first, so the least painful option
        // is the one nearest the top rather than whichever happens to be first in the list.
        const sources = buckets
          .filter((b) => b.id !== bucket.id && b.balance > 0)
          .sort((a, b) => b.balance - a.balance);
        const Icon = resolveBucketIcon(bucket.iconKey);

        return (
          <div
            key={bucket.id}
            className="rounded-2xl border border-border/60 bg-card p-5 shadow-[0_1px_2px_oklch(0.22_0.02_160/0.04)]"
          >
            <div className="flex items-start gap-3">
              <div
                className="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: bucket.accent }}
              >
                <Icon className="h-5 w-5 text-foreground/80" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-medium">
                  {bucket.name} is {formatCurrency(deficit)} over
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  It can stay that way. Or the money can come out of somewhere that has it.
                </p>
              </div>
            </div>

            {sources.length > 0 ? (
              <div className="mt-4 grid gap-2">
                {sources.map((source) => {
                  const amount = Math.min(deficit, source.balance);
                  const partial = amount < deficit;
                  const SourceIcon = resolveBucketIcon(source.iconKey);

                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => coverBucket(source.id, bucket.id, amount)}
                      className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-border bg-card hover:border-primary/50 hover:bg-secondary/50 transition-all active:scale-[0.98] text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: source.accent }}
                        >
                          <SourceIcon className="h-4 w-4 text-foreground/80" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{source.name}</div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {formatCurrency(source.balance)} →{" "}
                            {formatCurrency(source.balance - amount)}
                          </div>
                        </div>
                      </div>
                      <span
                        className={cn(
                          "text-xs tabular-nums shrink-0",
                          partial ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {partial
                          ? `covers ${formatCurrency(amount)} of ${formatCurrency(deficit)}`
                          : `covers ${formatCurrency(amount)}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Nothing else has anything in it right now, so this one stays over for now.
              </p>
            )}

            <button
              type="button"
              onClick={() => setLeft((prev) => [...prev, bucket.id])}
              className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Leave it
            </button>
          </div>
        );
      })}
    </div>
  );
}
