import { createServerFn } from "@tanstack/react-start";
import { getOrCreateSessionId } from "@/lib/server/session";
import { runShop, type ShopResult } from "@/lib/server/shop";

/**
 * The browser's way to send the shopping agent out. The session cookie decides whose buckets
 * and whose holds; nothing about buckets or money is taken from the request.
 */

export type { ShopResult };

/** Sandbox demo ceiling. Keeps a stray request from placing an absurd hold. */
const MAX_PRICE_CENTS = 500_00;

function validate(data: unknown): { request: string; maxPriceCents?: number } {
  if (typeof data !== "object" || data === null) throw new Error("Invalid request");
  const { request, maxPriceCents } = data as Record<string, unknown>;
  if (typeof request !== "string" || request.trim().length < 2) {
    throw new Error("Say what to shop for");
  }
  if (
    maxPriceCents !== undefined &&
    (typeof maxPriceCents !== "number" || !Number.isInteger(maxPriceCents) || maxPriceCents <= 0)
  ) {
    throw new Error("maxPriceCents must be a positive whole number of cents");
  }
  return {
    request: request.trim().slice(0, 200),
    maxPriceCents: Math.min(maxPriceCents ?? MAX_PRICE_CENTS, MAX_PRICE_CENTS),
  };
}

export const shopWithAgent = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<ShopResult> =>
    runShop({ sessionId: getOrCreateSessionId(), ...data }),
  );
