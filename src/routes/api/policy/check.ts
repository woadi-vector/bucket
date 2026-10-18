import { createFileRoute } from "@tanstack/react-router";
import { decidePolicy, parsePolicyInput } from "@/lib/server/policy";

/**
 * POST /api/policy/check: ask Bucket whether a purchase should be captured now or held.
 *
 * For any shopping agent, not only Bucket's own. The agent sends the bucket's tag, the amount
 * in cents, and optionally the person's threshold and a screen result; Bucket answers
 * `capture` or `hold` with a plain reason. The agent keeps its own PayPal authorization and
 * acts on the answer itself: this endpoint advises and never touches anyone's money.
 *
 *   curl -X POST <url>/api/policy/check -H "content-type: application/json" \
 *        -d '{"bucketTag":"want","amountCents":8999}'
 *   {"decision":"hold","reason":"A want over $40.00. Holding it to sleep on."}
 *
 * Deterministic and free to call: no model and no PayPal request sits behind it.
 */
export const Route = createFileRoute("/api/policy/check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Body must be JSON." }, { status: 400 });
        }
        const input = parsePolicyInput(body);
        if (!input) {
          return Response.json(
            {
              error:
                "Expected { bucketTag: 'need' | 'want', amountCents: positive integer, holdThresholdCents?: integer, screen?: 'agree' | 'mismatch' }.",
            },
            { status: 400 },
          );
        }
        return Response.json(decidePolicy(input));
      },
    },
  },
});
