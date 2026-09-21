import { Transaction, ReadinessTag, formatCurrency, READINESS_OPTIONS } from "@/lib/bucket-store";
import { motion } from "framer-motion";
import { Zap, PauseOctagon } from "lucide-react";

type Props = {
  transactions: Transaction[];
  savedByPause: number;
};

export function ReadinessInsights({ transactions, savedByPause }: Props) {
  const wantTx = transactions.filter((t) => t.intent === "want" && t.readinessTag);

  const impulseSpend = wantTx
    .filter((t) => t.readinessTag === "impulse")
    .reduce((s, t) => s + t.amount, 0);

  const tagTotals: Record<ReadinessTag, number> = {
    impulse: 0,
    saw_today: 0,
    over_a_week: 0,
    replacing: 0,
  };
  const tagCounts: Record<ReadinessTag, number> = {
    impulse: 0,
    saw_today: 0,
    over_a_week: 0,
    replacing: 0,
  };

  for (const t of wantTx) {
    if (t.readinessTag) {
      tagTotals[t.readinessTag] += t.amount;
      tagCounts[t.readinessTag] += 1;
    }
  }

  const maxBar = Math.max(...Object.values(tagTotals), 1);
  const hasData = wantTx.length > 0 || savedByPause > 0;

  return (
    <section className="mt-8 grid gap-3 sm:grid-cols-5">
      {/* Impulse stat */}
      <div className="sm:col-span-3 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
          <Zap className="h-3.5 w-3.5 text-amber-500" />
          <span>Impulse insight</span>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {hasData ? formatCurrency(impulseSpend) : "$0"}
          </span>
          <span className="text-sm text-muted-foreground">
            {hasData ? "impulse spend" : "tag wants to see your shape"}
          </span>
        </div>
        {savedByPause > 0 ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-secondary/50 px-3.5 py-2.5">
            <PauseOctagon className="h-4 w-4 text-emerald-500 shrink-0" />
            <p className="text-sm text-muted-foreground">
              You let go of{" "}
              <span className="font-semibold text-foreground tabular-nums">
                {formatCurrency(savedByPause)}
              </span>{" "}
              in impulse wants.
            </p>
          </div>
        ) : hasData ? (
          <p className="mt-3 text-xs text-muted-foreground">Every paused want is money kept.</p>
        ) : null}
      </div>

      {/* Readiness breakdown */}
      <div className="sm:col-span-2 rounded-2xl border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Wanting shape</p>
        <div className="mt-4 space-y-3">
          {READINESS_OPTIONS.map((opt) => {
            const value = tagTotals[opt.id];
            const count = tagCounts[opt.id];
            const pct = maxBar > 0 ? (value / maxBar) * 100 : 0;
            return (
              <div key={opt.id} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{opt.label}</span>
                  <span className="tabular-nums font-medium text-foreground">
                    {count > 0 ? formatCurrency(value) : "—"}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="h-full rounded-full bg-primary/70"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
