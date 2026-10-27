import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Transaction, formatCurrency, shortModelName } from "@/lib/bucket-store";
import {
  EXPLANATION_LIMIT,
  canOverride,
  canSubmitExplanation,
  exchangeState,
  remainingCharacters,
} from "@/lib/reconsideration";
import { useBucketActions } from "@/lib/bucket/provider";
import { cn } from "@/lib/utils";
import { Moon, Scale, Loader2, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Props = {
  transaction: Transaction | null;
  bucketName: string | undefined;
  onRetract: () => void;
  onOverride: () => void;
  onDismiss: () => void;
};

/**
 * The moment Bucket says it disagrees with you, and the conversation that follows.
 *
 * Two rules shape everything here. Bucket advises and can be overridden, so keeping the
 * purchase is a real, unpunished choice at every step and the copy never scolds. And Bucket
 * does not predict, it argues from what you have already done, which is why the reasoning is
 * quoted rather than summarised into a score.
 *
 * It appears seconds after the purchase was logged, because the model is not fast enough to
 * ask beforehand. That is why it offers to pull the purchase back rather than pretending it
 * caught it in time.
 *
 * The second half is the part that was missing. The engine has always produced a question
 * and always had a reconsideration pass that weighs an answer, and until now nothing in the
 * app could reach either. An argument you cannot answer is not advice, it is a verdict with
 * extra steps, and the whole premise of this card is that the person knows things about
 * their own life that their spending history does not record.
 */
export function RetractionCard({
  transaction,
  bucketName,
  onRetract,
  onOverride,
  onDismiss,
}: Props) {
  const { explainVerdict } = useBucketActions();
  const [answering, setAnswering] = useState(false);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");

  const verdict = transaction?.verdict;
  const state = exchangeState({
    verdict,
    reconsideration: transaction?.reconsideration,
    answering,
    pending,
  });

  const open = state !== "none";

  // A new argument starts a new conversation. Without this the box would open carrying the
  // last purchase's half-typed answer.
  useEffect(() => {
    setAnswering(false);
    setPending(false);
    setText("");
  }, [transaction?.id]);

  const send = async () => {
    if (!transaction || !canSubmitExplanation(text)) return;
    setPending(true);
    try {
      await explainVerdict(transaction.id, text.trim());
    } finally {
      setPending(false);
    }
  };

  const settled = transaction?.reconsideration;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent className="sm:max-w-md rounded-3xl p-0 overflow-hidden" data-demo="retraction">
        <DialogTitle className="sr-only">Bucket has a second thought</DialogTitle>
        {transaction && verdict && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="p-7"
          >
            <div
              className={cn(
                "mx-auto h-14 w-14 rounded-full flex items-center justify-center",
                state === "accepted" ? "bg-primary/15" : "bg-accent",
              )}
            >
              {state === "accepted" ? (
                <Check className="h-7 w-7 text-primary" />
              ) : (
                <Scale className="h-7 w-7 text-accent-foreground" />
              )}
            </div>

            <h2 className="mt-5 text-center text-xl font-semibold">
              {state === "accepted"
                ? "Fair enough."
                : state === "held"
                  ? "Thanks for explaining."
                  : "A second thought"}
            </h2>

            <p className="mt-1.5 text-center text-sm text-muted-foreground">
              {transaction.label} · {formatCurrency(transaction.amount)}
              {bucketName ? ` · ${bucketName}` : ""}
            </p>

            {/* The disagreement, stated plainly: your word against Bucket's. Kept on screen
                after an answer, because what changed is only legible beside what it changed
                from. */}
            <div className="mt-5 flex items-stretch gap-2">
              <div className="flex-1 rounded-2xl border border-border bg-card px-4 py-3 text-center">
                <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  You called it
                </p>
                <p className="mt-1 text-lg font-semibold capitalize">{transaction.intent}</p>
              </div>
              <div className="flex items-center text-muted-foreground text-sm">vs</div>
              <div
                className={cn(
                  "flex-1 rounded-2xl px-4 py-3 text-center border-2",
                  state === "accepted"
                    ? "border-border bg-card opacity-60"
                    : "border-primary/40 bg-accent/40",
                )}
              >
                <p
                  className={cn(
                    "text-[10px] uppercase tracking-[0.16em]",
                    state === "accepted" ? "text-muted-foreground" : "text-primary/80",
                  )}
                >
                  {state === "accepted" ? "Bucket thought" : "Bucket thinks"}
                </p>
                <p className="mt-1 text-lg font-semibold capitalize">{verdict.verdict}</p>
              </div>
            </div>

            <blockquote className="mt-5 rounded-2xl bg-secondary/60 px-4 py-3.5 text-sm leading-relaxed text-foreground">
              {verdict.reasoning}
            </blockquote>

            {/*
              Who actually said it. Sits under the argument rather than at the top because it
              is provenance, not a headline, and it is the only place in the app where the
              tiering is visible on a single case. The provider is named only when a real
              adapter answered, so this can never credit infrastructure that was not used.
            */}
            {verdict.attribution && (
              <p className="mt-2.5 text-center text-[11px] leading-relaxed text-muted-foreground">
                Screened by{" "}
                <span className="text-foreground/75 font-medium">
                  {shortModelName(verdict.attribution.screened)}
                </span>
                {verdict.attribution.adjudicated && (
                  <>
                    , escalated to{" "}
                    <span className="text-foreground/75 font-medium">
                      {shortModelName(verdict.attribution.adjudicated)}
                    </span>
                  </>
                )}
                {verdict.attribution.provider === "token-factory" && " on Nebius Token Factory"}
              </p>
            )}

            <AnimatePresence mode="wait">
              {/* Contested. The question is an invitation, so it is offered beside two ways
                  of ending the conversation without answering it. */}
              {state === "contested" && (
                <motion.div
                  key="contested"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {verdict.question && (
                    <p className="mt-5 text-center text-sm font-medium leading-relaxed">
                      {verdict.question}
                    </p>
                  )}

                  <div className="mt-6 grid gap-2">
                    {verdict.question && (
                      <Button
                        onClick={() => setAnswering(true)}
                        className="h-12 rounded-xl text-base"
                      >
                        Let me explain
                      </Button>
                    )}
                    <Button
                      variant={verdict.question ? "outline" : "default"}
                      onClick={onRetract}
                      className="h-12 rounded-xl text-base"
                    >
                      <Moon className="mr-1.5 h-4 w-4" />
                      Put it back, let me sleep on it
                    </Button>
                    <Button
                      variant="outline"
                      onClick={onOverride}
                      className="h-12 rounded-xl text-base"
                    >
                      No, I meant it, keep the purchase
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Answering. Skipping is as easy as sending, and the counter exists so nobody
                  writes past the server's limit and has it cut silently. */}
              {state === "answering" && (
                <motion.div
                  key="answering"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <textarea
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, EXPLANATION_LIMIT))}
                    placeholder="Why was this one a need?"
                    rows={3}
                    className="mt-5 w-full resize-none rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed outline-none focus:border-primary/50"
                  />
                  <p className="mt-1 text-right text-[11px] text-muted-foreground tabular-nums">
                    {remainingCharacters(text)} left
                  </p>

                  <div className="mt-4 grid gap-2">
                    <Button
                      onClick={send}
                      disabled={!canSubmitExplanation(text)}
                      className="h-12 rounded-xl text-base"
                    >
                      Send it
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setAnswering(false)}
                      className="h-12 rounded-xl text-base"
                    >
                      Never mind
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Thinking. Named rather than spun silently, because the person just typed
                  something and deserves to know it went somewhere. */}
              {state === "thinking" && (
                <motion.div
                  key="thinking"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="mt-6"
                >
                  <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Bucket is reading that back
                  </div>
                  <Button
                    variant="outline"
                    onClick={onOverride}
                    className="h-12 w-full rounded-xl text-base"
                  >
                    Keep the purchase anyway
                  </Button>
                </motion.div>
              )}

              {/* Accepted. Bucket changed its mind, which is worth saying in those words:
                  an app that only ever wins its arguments is not weighing anything. */}
              {state === "accepted" && settled && (
                <motion.div
                  key="accepted"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {settled.reasoning && (
                    <blockquote className="mt-5 rounded-2xl bg-primary/10 px-4 py-3.5 text-sm leading-relaxed text-foreground">
                      {settled.reasoning}
                    </blockquote>
                  )}
                  <p className="mt-4 text-center text-sm text-muted-foreground">
                    Your call stands, and the purchase stays as you tagged it.
                  </p>
                  <Button onClick={onDismiss} className="mt-5 h-12 w-full rounded-xl text-base">
                    Good
                  </Button>
                </motion.div>
              )}

              {/* Held. The explanation did not move it, said without shaming anyone, and the
                  way out is the first button rather than something to hunt for. */}
              {state === "held" && settled && (
                <motion.div
                  key="held"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {settled.reasoning && (
                    <blockquote className="mt-5 rounded-2xl bg-secondary/60 px-4 py-3.5 text-sm leading-relaxed text-foreground">
                      {settled.reasoning}
                    </blockquote>
                  )}
                  <p className="mt-4 text-center text-sm text-muted-foreground">
                    That did not change its mind, which does not make it right.
                  </p>

                  <div className="mt-5 grid gap-2">
                    <Button onClick={onOverride} className="h-12 rounded-xl text-base">
                      Keep the purchase
                    </Button>
                    <Button
                      variant="outline"
                      onClick={onRetract}
                      className="h-12 rounded-xl text-base"
                    >
                      <Moon className="mr-1.5 h-4 w-4" />
                      Actually, put it back
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {canOverride(state) && (
              <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/80">
                Bucket is reading your own spending back to you. It can be wrong, and it is your
                money either way.
              </p>
            )}
          </motion.div>
        )}
      </DialogContent>
    </Dialog>
  );
}
