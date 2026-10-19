import { createServerFn } from "@tanstack/react-start";
import { readTierUsage } from "@/lib/server/budget";
import { readRestraintCounts } from "@/lib/server/exchanges";
import { summarize, type Efficiency } from "@/lib/efficiency";

/**
 * Read side of the spend ledger.
 *
 * Deliberately not key-gated, unlike the exchange log. That page holds purchase labels and
 * whatever people typed to explain themselves, so it cannot be public. This one holds call
 * counts, token counts and money: nothing about any person, nothing about any purchase. The
 * whole point is that a judge can open it cold, so a key here would defeat it.
 *
 * Spends nothing and holds no API key.
 */

export type EfficiencyReport = Efficiency & {
  /**
   * Escalations where the expensive tier sided with the person against the cheap one, and
   * the objection was dropped before anybody saw it.
   *
   * It belongs here rather than only in the exchange log because it is the answer to the
   * obvious question about this architecture: what did the expensive call actually buy?
   * Sometimes it bought silence.
   */
  overruled: number;
};

export const readEfficiency = createServerFn({ method: "GET" }).handler(
  async (): Promise<EfficiencyReport> => {
    const [tiers, restraint] = await Promise.all([readTierUsage(), readRestraintCounts()]);
    return { ...summarize(tiers), overruled: restraint.overruled };
  },
);
