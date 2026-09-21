import type { ChatMessage } from "./adapter";
import type { HistoricalPurchase, VerdictRequest } from "./types";

/** How many prior purchases to show the model. Enough for a pattern, short enough to stay cheap. */
const HISTORY_LIMIT = 12;

const READINESS_LABEL: Record<string, string> = {
  impulse: "decided on the spot",
  saw_today: "first saw it today",
  over_a_week: "has wanted it for over a week",
  replacing: "replacing something they already had",
};

const money = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

function describeHistory(history: HistoricalPurchase[], now: number): string {
  if (history.length === 0) return "No prior purchases on record.";

  return [...history]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, HISTORY_LIMIT)
    .map((h) => {
      const days = Math.max(0, Math.round((now - h.timestamp) / 86_400_000));
      const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
      const readiness = h.readinessTag ? `, ${READINESS_LABEL[h.readinessTag]}` : "";
      const bucket = h.bucketName ? ` from ${h.bucketName}` : "";
      return `- ${when}: ${h.label}${bucket}, ${money(h.amount)}, they called it a ${h.intent}${readiness}`;
    })
    .join("\n");
}

/**
 * The engine's whole opinion about how to ask the question lives here.
 *
 * The framing is deliberate. The model is not asked to predict or to approve a purchase —
 * the plan is explicit that Bucket advises and can be overridden, and must not claim to
 * predict. It is asked to judge one thing: whether the user's own label holds up against
 * their own history.
 */
export function buildVerdictPrompt(
  request: VerdictRequest,
  now: number = Date.now(),
): ChatMessage[] {
  const { purchase, history } = request;

  const system = [
    "You judge whether a person's own label on a purchase is honest.",
    "",
    'A "need" is something whose absence causes a real problem: food, medicine, a work tool that is',
    'broken, a bill. A "want" is everything else, including pleasant, reasonable, affordable things.',
    "A want is not a moral failure and you must never scold. Many wants are worth buying.",
    "",
    "Your only question is whether the label matches the purchase, judged against how this person",
    "has labelled their own spending before. If someone calls something a need and their history",
    "shows they routinely call comforts needs, say so plainly and say why.",
    "",
    "Do not predict the future. Do not approve or forbid the purchase. The person decides.",
    "",
    "Reply with JSON only, no prose around it:",
    '{"verdict":"want"|"need","confidence":0.0-1.0,"reasoning":"one or two sentences, addressed to the person as \\"you\\""}',
  ].join("\n");

  const readiness = purchase.readinessTag
    ? `They ${READINESS_LABEL[purchase.readinessTag]}.`
    : "They did not say how long they had wanted it.";

  const user = [
    `Purchase: ${purchase.label}`,
    `Amount: ${money(purchase.amount)}`,
    purchase.bucketName ? `Bucket: ${purchase.bucketName}` : null,
    `They labelled it: ${purchase.intent}`,
    readiness,
    purchase.note ? `They added: ${purchase.note}` : null,
    "",
    "Their recent spending:",
    describeHistory(history, now),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
