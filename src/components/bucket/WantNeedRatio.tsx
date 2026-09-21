import { Transaction } from "@/lib/bucket-store";
import { motion } from "framer-motion";

export function WantNeedRatio({ transactions }: { transactions: Transaction[] }) {
  const total = transactions.length;
  const needs = transactions.filter((t) => t.intent === "need").length;
  const pct = total === 0 ? 0 : Math.round((needs / total) * 100);

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">This month</p>
        <p className="text-xs text-muted-foreground tabular-nums">{needs}/{total}</p>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="text-3xl font-semibold tabular-nums">{pct}%</div>
        <div className="text-sm text-muted-foreground">needs</div>
      </div>
      <div className="mt-4 h-2 w-full rounded-full bg-secondary overflow-hidden flex">
        <motion.div
          className="h-full"
          style={{ backgroundColor: "var(--need)" }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
        <motion.div
          className="h-full"
          style={{ backgroundColor: "var(--want)" }}
          initial={{ width: 0 }}
          animate={{ width: `${100 - pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>Needs</span>
        <span>Wants</span>
      </div>
    </div>
  );
}
