import type { ChatMessage } from "./adapter";
import type { HistoricalPurchase, ReconsiderRequest, VerdictRequest } from "./types";
import { describeEvidence, type Evidence } from "./evidence";
import type { PriceFinding } from "./pricing";

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
    "If you disagree with their label, also write the one question you would ask them before",
    "deciding — the thing you do not know that would change your mind. Ask about this purchase,",
    "not about their finances in general, and ask it in one short sentence. Omit the question when",
    "you agree with their label; there is nothing to settle.",
    "",
    "Reply with JSON only, no prose around it:",
    '{"verdict":"want"|"need","confidence":0.0-1.0,"reasoning":"one or two sentences, addressed to the person as \\"you\\"","question":"one sentence, or omit when you agree"}',
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
    purchase.context ? `Context, not from the person: ${purchase.context}` : null,
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

/**
 * Named moves people make to describe a want in the language of a need.
 *
 * These are the heart of the reconsideration. Without them the model treats any stated
 * purpose as decisive, every user learns within a day that typing a reason is the bypass,
 * and Bucket becomes a speed bump with extra steps. With them, an explanation is evidence
 * to be weighed against the person's own history, which is what was promised.
 *
 * The list is a working draft pending review by the behavioural side of the project. It is
 * deliberately phrased as patterns to recognise, never as accusations to make.
 */
const RATIONALISATION_PATTERNS = [
  '- The Bundle: folding a want into a legitimate category. "I was buying groceries anyway."',
  '- The Upgrade: replacing something that still works. "My old one is getting old."',
  '- The Clock: urgency manufactured by a sale or a deadline. "It is 40% off today."',
  '- The Virtue: routing through health, children, or work. "It is for my health."',
  '- The Reward: earned by prior restraint. "I have been good all month."',
  '- The Sunk Trip: effort already spent. "I already drove out here."',
  '- The Round Up: too small to count. "It is only twelve dollars."',
  '- The Someday: a future use justifying a present purchase. "I will definitely use this."',
].join("\n");

/**
 * The second pass: the person has answered, and the engine decides whether that answer holds.
 *
 * Two failure modes are being steered away from at once, and they pull in opposite
 * directions. A model that accepts every explanation makes the question theatre. A model
 * that accepts none makes asking it an insult. The instruction is therefore to weigh, and
 * to say plainly which way it went and why.
 */
export function buildReconsiderPrompt(
  request: ReconsiderRequest,
  now: number = Date.now(),
  evidence?: Evidence,
  finding?: PriceFinding,
): ChatMessage[] {
  const { purchase, history, question, explanation, priorVerdict } = request;

  const system = [
    "You judged a person's label on a purchase, you asked them one question, and they answered.",
    "Decide whether their answer changes your judgement.",
    "",
    "Weigh the explanation. Do not simply accept it, and do not simply dismiss it. A stated",
    "purpose is evidence, not a password. Someone explaining themselves is usually telling the",
    "truth about their situation and may well be describing a real need you could not see.",
    "",
    "These are the common ways a want gets described as a need. Recognising one is a reason to",
    "look harder at the person's history, not a reason to reject them:",
    "",
    RATIONALISATION_PATTERNS,
    "",
    "If the explanation gives you a fact you did not have, and their history does not contradict",
    "it, change your verdict and say what convinced you. If it restates the original label in",
    "other words, or matches a pattern above that their own history already shows, keep your",
    "verdict and say so kindly and specifically. Never scold, never moralise, and never mention",
    "what they can or cannot afford. They decide what to buy either way.",
    "",
    "Reply with JSON only, no prose around it:",
    '{"verdict":"want"|"need","confidence":0.0-1.0,"reasoning":"one or two sentences, addressed to the person as \\"you\\", naming what did or did not move you"}',
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
    purchase.context ? `Context, not from the person: ${purchase.context}` : null,
    "",
    `You judged it: ${priorVerdict}`,
    `You asked: ${question}`,
    `They answered: ${explanation}`,
    "",
    "Their recent spending:",
    describeHistory(history, now),
    // Last, and only when there is something. The model weighs what the person said first;
    // a lookup is a check on that, not the starting point.
    evidence ? `\n${describeEvidence(evidence, finding)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
