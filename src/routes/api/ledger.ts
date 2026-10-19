import { createFileRoute } from "@tanstack/react-router";
import { readLedgerData } from "@/lib/server/ledger";

/**
 * GET /api/ledger: every PayPal hold Bucket has placed and every purchase the agent refused
 * before PayPal was called, newest first, with the totals, as JSON.
 *
 * Public on purpose. Each hold carries PayPal's authorization id, so anyone can set a row beside
 * PayPal's own record instead of trusting this one. Voided holds and refusals stay in the list;
 * what Bucket held back is the point of the product. Rows hold no visitor identifier.
 */
export const Route = createFileRoute("/api/ledger")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(await readLedgerData(), { headers: { "cache-control": "no-store" } }),
    },
  },
});
