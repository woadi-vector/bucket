import { createServerFn } from "@tanstack/react-start";
import {
  exchangeLogUnlocked,
  readExchangeSummary,
  readExchanges,
  type ExchangeRow,
  type ExchangeSummary,
} from "@/lib/server/exchanges";

/**
 * Read side of the exchange log.
 *
 * Kept apart from `verdict-fns.ts` because this module holds no API key and spends nothing.
 * It reads what already happened.
 */

export type ExchangeLog =
  { unlocked: false } | { unlocked: true; summary: ExchangeSummary; rows: ExchangeRow[] };

function validateKey(data: unknown): { key: string | null } {
  if (typeof data !== "object" || data === null) return { key: null };
  const { key } = data as Record<string, unknown>;
  return { key: typeof key === "string" ? key.slice(0, 256) : null };
}

/**
 * Returns the log, or refuses.
 *
 * A refusal says nothing about why. The caller cannot tell a wrong key from an unset one,
 * because the difference is only useful to someone guessing.
 */
export const readExchangeLog = createServerFn({ method: "POST" })
  .inputValidator(validateKey)
  .handler(async ({ data }): Promise<ExchangeLog> => {
    if (!exchangeLogUnlocked(data.key)) return { unlocked: false };

    const [summary, rows] = await Promise.all([readExchangeSummary(), readExchanges(100)]);
    return { unlocked: true, summary, rows };
  });
