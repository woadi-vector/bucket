import { useCallback, useEffect, useRef, useState } from "react";
import { keepHold, letGoHold, readMyHolds, type HoldDecision, type PublicHold } from "./hold-fns";

/**
 * This visitor's PayPal holds, kept fresh.
 *
 * The server ends expired holds whenever they are read, so refreshing is also how the clock gets
 * applied: when a countdown reaches zero the tray asks again and the hold comes back voided.
 */
export function usePayPalHolds() {
  const [holds, setHolds] = useState<PublicHold[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setHolds(await readMyHolds());
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
