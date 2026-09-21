import { Bucket, formatCurrency } from "@/lib/bucket-store";
import { cn } from "@/lib/utils";

type Props = {
  bucket: Bucket;
  startingBalance: number;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  justUpdated?: boolean;
};

export function BucketCard({
  bucket,
  startingBalance,
  selectable,
  selected,
  onClick,
  justUpdated,
}: Props) {
  const spent = Math.max(0, startingBalance - bucket.balance);
  const pct = startingBalance > 0 ? Math.min(100, (spent / startingBalance) * 100) : 0;
  const isChild = bucket.ownerType === "child";
  const overLimit = bucket.limit != null && spent > bucket.limit;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!selectable && !onClick}
      data-bucket-id={bucket.id}
      className={cn(
        "group relative w-full text-left rounded-2xl bg-card p-5 transition-all duration-300",
        "border border-border/60",
        "shadow-[0_1px_2px_oklch(0.22_0.02_160/0.04),0_8px_24px_oklch(0.22_0.02_160/0.05)]",
        selectable &&
          "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_2px_4px_oklch(0.22_0.02_160/0.06),0_16px_40px_oklch(0.22_0.02_160/0.08)] active:scale-[0.99]",
        selected && "ring-2 ring-primary border-primary/40",
        justUpdated && "animate-[pulse-ring_0.9s_ease-out]",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: bucket.accent }}
        >
          <bucket.icon className="h-5 w-5 text-foreground/80" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-muted-foreground tracking-wide">
              {bucket.name}
            </h3>
            {isChild && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-medium">
                Kids
              </span>
            )}
          </div>
          <div className="mt-1.5 text-3xl font-semibold tabular-nums text-foreground">
            {formatCurrency(bucket.balance)}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              overLimit ? "bg-destructive" : "bg-primary/80",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{formatCurrency(spent)} spent</span>
          {bucket.limit != null ? (
            <span>Limit {formatCurrency(bucket.limit)}</span>
          ) : (
            <span>of {formatCurrency(startingBalance)}</span>
          )}
        </div>
      </div>
    </button>
  );
}
