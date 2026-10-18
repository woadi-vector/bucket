import { createFileRoute } from "@tanstack/react-router";
import { listHolds, toPublicHold } from "@/lib/server/holds";
import { sweepExpired } from "@/lib/server/payments";

/**
 * GET /api/ledger: every PayPal hold Bucket has placed, newest first, as JSON.
 *
 * Public on purpose. Each row carries PayPal's authorization id, so anyone can set a row beside
 * PayPal's own record instead of trusting this one. Voided holds stay in the list; the let-go is
 * the point of the product. Rows hold no visitor identifier.
 */
export const Route = createFileRoute("/api/ledger")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await sweepExpired();
        } catch (error) {
          console.error("[ledger] sweep failed", error);
        }
        const holds = (await listHolds(100)).map(toPublicHold);
        return Response.json(
          { holds, generatedAt: new Date().toISOString() },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
