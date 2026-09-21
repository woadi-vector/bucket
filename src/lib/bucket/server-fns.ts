import { createServerFn } from "@tanstack/react-start";
import { getOrCreateSessionId } from "@/lib/server/session";
import { getStore } from "@/lib/server/store";
import { createSeededState, validateBucketState } from "./persistence";
import type { BucketState } from "./reducer";

/**
 * Loads this visitor's state, seeding one on first visit.
 *
 * Called from the route loader so it runs during SSR. That matters beyond speed: the hero
 * number's count-up and confetti fire on a positive *change* to `savedByPause`, so a page
 * that rendered 0 and then hydrated to the stored value would throw confetti on every cold
 * load. Arriving with the right number in the very first render avoids that entirely.
 *
 * Never throws. Storage being unavailable must degrade to a working app, not a 500 — a
 * judge opening the URL is the one case that has to work.
 */
export const loadBucketState = createServerFn({ method: "GET" }).handler(
  async (): Promise<BucketState> => {
    try {
      const sessionId = getOrCreateSessionId();
      const store = getStore();
      const existing = await store.load(sessionId);
      if (existing) return existing;

      const seeded = createSeededState();
      await store.save(sessionId, seeded);
      return seeded;
    } catch (error) {
      console.error("[bucket] load failed; serving an unsaved seed", error);
      return createSeededState();
    }
  },
);

export const saveBucketState = createServerFn({ method: "POST" })
  .inputValidator((data: unknown): BucketState => {
    const valid = validateBucketState(data);
    if (!valid) throw new Error("Invalid bucket state");
    return valid;
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    try {
      await getStore().save(getOrCreateSessionId(), data);
      return { ok: true };
    } catch (error) {
      console.error("[bucket] save failed", error);
      return { ok: false };
    }
  });
