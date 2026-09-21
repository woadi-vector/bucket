import { AnimatePresence, motion } from "framer-motion";
import { Bucket, ParentRequest, formatCurrency } from "@/lib/bucket-store";
import { Button } from "@/components/ui/button";
import { Check, X, Bell } from "lucide-react";

type Props = {
  requests: ParentRequest[];
  buckets: Bucket[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
};

export function ParentInbox({ requests, buckets, onApprove, onDeny }: Props) {
  const pending = requests.filter((r) => r.status === "pending");

  return (
    <section className="mt-8 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Approval requests</h3>
        {pending.length > 0 && (
          <span className="ml-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground font-medium">
            {pending.length}
          </span>
        )}
      </div>
      {pending.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No pending requests.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          <AnimatePresence initial={false}>
            {pending.map((r) => {
              const b = buckets.find((x) => x.id === r.bucketId);
              return (
                <motion.li
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate text-sm">{r.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatCurrency(r.amount)} · {b?.name}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-9 w-9 rounded-lg"
                      onClick={() => onDeny(r.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      className="h-9 w-9 rounded-lg"
                      onClick={() => onApprove(r.id)}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
