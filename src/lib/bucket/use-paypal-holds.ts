import { useCallback, useEffect, useRef, useState } from "react";
import { keepHold, letGoHold, readMyHolds, type HoldDecision, type PublicHold } from "./hold-fns";

/**
 * This visitor's PayPal holds, kept fresh.
 *
 * The server ends expired holds whenever they are read, so refreshing is also how the clock gets
 * applied: when a countdown reaches zero the tray asks again and the hold comes back voided.
 */
export function usePayPalHolds(options?: {
  /**
   * Called once for each hold this tab saw waiting that has since been released by the clock.
   * Holds that ended before the page loaded are not reported: the app cannot tell those from
   * ones it already counted, so they are left alone rather than counted twice.
   */
  onClockRelease?: (hold: PublicHold) => void;
}) {
  const [holds, setHolds] = useState<PublicHold[]>([]);
  const seenWaiting = useRef(new Set<string>());
  const onClockRelease = useRef(options?.onClockRelease);
  onClockRelease.current = options?.onClockRelease;
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await readMyHolds();
      for (const h of next) {
        if (h.state === "held" || h.state === "deciding") {
          seenWaiting.current.add(h.id);
        } else if (seenWaiting.current.has(h.id)) {
          seenWaiting.current.delete(h.id);
          if (h.state === "voided" && h.decidedBy === "clock") onClockRelease.current?.(h);
        }
      }
      setHolds(next);
    } catch (error) {
      console.error("[holds] refresh failed", error);
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = useCallback(
    async (id: string, action: "keep" | "letGo"): Promise<HoldDecision> => {
      setBusyId(id);
      try {
        const result =
          action === "keep" ? await keepHold({ data: { id } }) : await letGoHold({ data: { id } });
        await refresh();
        return result;
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return { holds, loaded, busyId, refresh, decide };
}
