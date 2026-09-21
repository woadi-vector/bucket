import { AnimatePresence, motion } from "framer-motion";
import { Bucket, PendingWant, SLEEP_THRESHOLD, formatCurrency } from "@/lib/bucket-store";
import { Button } from "@/components/ui/button";
import { Clock, Sparkles, Scale } from "lucide-react";

type Props = {
  items: PendingWant[];
  buckets: Bucket[];
  onConfirm: (id: string) => void;
  onLetGo: (id: string, sourceRect: DOMRect) => void;
};

export function PendingTray({ items, buckets, onConfirm, onLetGo }: Props) {
  const handleLetGo = (id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    const li = e.currentTarget.closest("li[data-pending-id]") as HTMLElement | null;
    const rect = (li ?? e.currentTarget).getBoundingClientRect();
    onLetGo(id, rect);
  };
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Clock className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing pending. Wants over {formatCurrency(SLEEP_THRESHOLD)} will land here for a 24h
          pause.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      <AnimatePresence initial={false}>
        {items.map((p) => {
          const b = buckets.find((x) => x.id === p.bucketId);
          return (
            <motion.li
              key={p.id}
              data-pending-id={p.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.85, transition: { duration: 0.45 } }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              className="rounded-2xl border border-border bg-card p-4 sm:p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: `var(--${p.intent})` }}
                    />
                    <span className="capitalize">{p.intent}</span> · {b?.name ?? "—"}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCurrency(p.amount)}
                  </div>
                  <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {p.hoursLeft}h left
                  </div>
                </div>
              </div>
              {/* A contested tag, argued on the card. The item is already paused, so this
                  informs the decision rather than interrupting to demand one. */}
              {p.verdict && !p.verdict.agrees && p.verdict.reasoning && (
                <div className="mt-3.5 rounded-xl bg-secondary/60 px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-primary/80">
                    <Scale className="h-3 w-3" />
                    Bucket thinks this is a {p.verdict.verdict}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {p.verdict.reasoning}
                  </p>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl"
                  onClick={() => onConfirm(p.id)}
                >
                  Confirm purchase
                </Button>
                <Button
                  className="flex-1 h-10 rounded-xl bg-primary/90 hover:bg-primary"
                  onClick={(e) => handleLetGo(p.id, e)}
                >
                  <Sparkles className="mr-1 h-4 w-4" />
                  Let it go
                </Button>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
