import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Bucket,
  formatCurrency,
  PurchaseVerdict,
  shortModelName,
  ReadinessTag,
  READINESS_OPTIONS,
  resolveBucketIcon,
} from "@/lib/bucket-store";
import { orderForPlacement } from "@/lib/placement";
import { nextStepAfterBucket } from "@/lib/purchase-routing";
import { useBucketState } from "@/lib/bucket/provider";
import { cn } from "@/lib/utils";
import { Check, Moon, Zap, Send, Scale } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Step =
  | "amount"
  | "intent"
  | "readiness"
  | "bucket"
  | "secondThought"
  | "intercept"
  | "askParent"
  | "confirm";

/**
 * One selectable bucket in the picker, showing what it would be left with.
 *
 * The projection is the point of this row. It has shown `balance → balance - amount` since
 * the prototype, with the result in red when it would go under, which is where the cost of
 * a purchase is supposed to register: beside the alternatives, before anything is committed,
 * with no model involved and nothing blocked.
 */
function BucketOption({
  bucket,
  amount,
  onPick,
  emphasized,
}: {
  bucket: Bucket;
  amount: number;
  onPick: () => void;
  /** The guessed bucket, which sits on its own above the rest. */
  emphasized?: boolean;
}) {
  const after = bucket.balance - amount;
  const negative = after < 0;
  const empty = bucket.balance <= 0;
  const Icon = resolveBucketIcon(bucket.iconKey);

  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-3 p-4 rounded-xl border bg-card transition-all active:scale-[0.98] text-left",
        "hover:border-primary/50 hover:bg-secondary/50",
        emphasized ? "border-primary/40 ring-1 ring-primary/20" : "border-border",
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="h-9 w-9 shrink-0 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: bucket.accent }}
        >
          <Icon className="h-4 w-4 text-foreground/80" />
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">{bucket.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {formatCurrency(bucket.balance)} →{" "}
            <span className={cn(negative && "text-destructive")}>{formatCurrency(after)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {empty && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">
            Empty
          </span>
        )}
        {bucket.ownerType === "child" && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-medium">
            Kids
          </span>
        )}
      </div>
    </button>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  buckets: Bucket[];
  startingBalances: Record<string, number>;
  onConfirm: (
    data: {
      amount: number;
      label: string;
      bucketId: string;
      intent: "want" | "need";
      readinessTag: ReadinessTag | null;
    },
    settled?: { verdict: PurchaseVerdict; openArgument?: boolean },
  ) => void;
  /**
   * Asks the engine about this purchase before it is made.
   *
   * Started when the bucket list opens so the call runs while the person is reading it.
   * Resolves to null when nothing usable came back in time, in which case the flow behaves
   * exactly as it always has and the argument arrives after the purchase instead.
   */
  onPreviewVerdict: (subject: {
    amount: number;
    label: string;
    intent: "want" | "need";
    readinessTag: ReadinessTag | null;
  }) => Promise<PurchaseVerdict | null>;
  onSleepOnIt: (data: {
    amount: number;
    label: string;
    bucketId: string;
    intent: "want" | "need";
    readinessTag: ReadinessTag | null;
  }) => void;
  onParentRequest: (data: { amount: number; label: string; bucketId: string }) => void;
  /** Pre-filled values for scripted demo. */
  prefill?: { amount: number; label: string; intent?: "want" | "need"; bucketId?: string } | null;
};

export function PurchaseFlow({
  open,
  onPreviewVerdict,
  onOpenChange,
  buckets,
  startingBalances,
  onConfirm,
  onSleepOnIt,
  onParentRequest,
  prefill,
}: Props) {
  const { sleepThreshold } = useBucketState();
  const [step, setStep] = useState<Step>("amount");
  /** The engine's answer, when it arrived before a bucket was chosen. */
  const [preview, setPreview] = useState<PurchaseVerdict | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [intent, setIntent] = useState<"want" | "need" | null>(null);
  const [bucketId, setBucketId] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessTag | null>(null);

  useEffect(() => {
    if (open) {
      if (prefill) {
        setAmount(String(prefill.amount));
        setLabel(prefill.label);
        setIntent(prefill.intent ?? null);
        setBucketId(prefill.bucketId ?? null);
        setStep("amount");
      } else {
        setStep("amount");
        setAmount("");
        setLabel("");
        setIntent(null);
        setBucketId(null);
        setReadiness(null);
      }
      setPreview(null);
      setPreviewing(false);
    }
  }, [open, prefill]);

  /**
   * Starts the screening call when the bucket list opens.
   *
   * The whole point of putting it here. Everything the engine needs is already known by this
   * step, so the call runs during the seconds the person spends reading five buckets and
   * their projected balances, instead of after the money has moved. On a tap that lands
   * after it returns, the disagreement can be raised before the purchase rather than as an
   * offer to undo one.
   *
   * It is never waited on. If the answer has not arrived by the time a bucket is chosen, the
   * purchase proceeds and the argument arrives afterwards exactly as it used to.
   */
  useEffect(() => {
    if (step !== "bucket" || !amtValid || !intent || preview || previewing) return;

    let live = true;
    setPreviewing(true);
    void onPreviewVerdict({
      amount: amt,
      label: label.trim(),
      intent,
      readinessTag: readiness,
    })
      .then((verdict) => {
        if (live) setPreview(verdict);
      })
      .finally(() => {
        if (live) setPreviewing(false);
      });

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const amt = parseFloat(amount);
  const amtValid = !isNaN(amt) && amt > 0 && label.trim().length > 0;
  const selectedBucket = buckets.find((b) => b.id === bucketId) ?? null;

  // Where the label says this belongs, worked out in code from the label alone. Recomputed
  // as the label changes rather than held in state, so it cannot go stale against an edit.
  const { guess, rest } = orderForPlacement(label, buckets);

  const pickBucket = (b: Bucket) => {
    setBucketId(b.id);
    const next = nextStepAfterBucket({
      bucket: b,
      amount: amt,
      intent: intent!,
      spent: Math.max(0, startingBalances[b.id] - b.balance),
      preview,
      sleepThreshold,
    });

    if (next === "commit") finalize(b.id);
    else setStep(next);
  };

  const finalize = (
    bId: string,
    settled?: { verdict: PurchaseVerdict; openArgument?: boolean },
  ) => {
    setStep("confirm");
    setTimeout(() => {
      onConfirm(
        {
          amount: amt,
          label: label.trim(),
          bucketId: bId,
          intent: intent!,
          readinessTag: readiness,
        },
        settled,
      );
    }, 1000);
    setTimeout(() => onOpenChange(false), 1350);
  };

  /** Carries the argument already shown, so the purchase does not ask a second time. */
  const commitWithPreview = (openArgument: boolean) => {
    if (!bucketId || !preview) return;
    finalize(bucketId, { verdict: preview, openArgument });
  };

  const sleepOnIt = () => {
    if (!bucketId) return;
    onSleepOnIt({
      amount: amt,
      label: label.trim(),
      bucketId,
      intent: intent ?? "want",
      readinessTag: readiness,
    });
    onOpenChange(false);
  };

  const sendParentRequest = () => {
    if (!bucketId) return;
    onParentRequest({ amount: amt, label: label.trim(), bucketId });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-3xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">New purchase</DialogTitle>
        <AnimatePresence mode="wait">
          {step === "amount" && (
            <motion.div
              key="amount"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="p-6 animate-fade-in">
                <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
                  Step 1 of 3
                </p>
                <h2 className="mt-1 text-2xl font-semibold">What are you buying?</h2>
                <div className="mt-6 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="amt">Amount</Label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl text-muted-foreground">
                        $
                      </span>
                      <Input
                        id="amt"
                        type="number"
                        inputMode="decimal"
                        autoFocus
                        placeholder="0"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="h-16 pl-10 text-3xl font-semibold tabular-nums rounded-2xl"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lbl">Where / what</Label>
                    <Input
                      id="lbl"
                      placeholder="e.g. Blue Bottle Coffee"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      className="h-12 rounded-xl"
                    />
                  </div>
                  <Button
                    disabled={!amtValid}
                    onClick={() => setStep("intent")}
                    className="w-full h-12 rounded-xl text-base"
                  >
                    Continue
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {step === "intent" && (
            <motion.div
              key="intent"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="p-6 animate-fade-in">
                <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">Step 2</p>
                <h2 className="mt-1 text-2xl font-semibold">Want or need?</h2>
                <p className="mt-1 text-sm text-muted-foreground">Take a breath. Be honest.</p>

                <div className="mt-6 grid grid-cols-2 gap-3">
                  <IntentButton
                    label="Need"
                    hint="Essential"
                    color="need"
                    selected={intent === "need"}
                    onClick={() => setIntent("need")}
                  />
                  <IntentButton
                    label="Want"
                    hint="A treat"
                    color="want"
                    selected={intent === "want"}
                    onClick={() => setIntent("want")}
                  />
                </div>

                <Button
                  disabled={!intent}
                  onClick={() => setStep(intent === "want" ? "readiness" : "bucket")}
                  className="mt-6 w-full h-12 rounded-xl text-base"
                >
                  Continue
                </Button>
              </div>
            </motion.div>
          )}

          {step === "readiness" && (
            <motion.div
              key="readiness"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="p-6 animate-fade-in">
                <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
                  Step 3 of 4
                </p>
                <h2 className="mt-1 text-2xl font-semibold">How long have you wanted it?</h2>
                <p className="mt-1 text-sm text-muted-foreground">One tap. No wrong answer.</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {READINESS_OPTIONS.map((o) => {
                    const selected = readiness === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          setReadiness(o.id);
                          setTimeout(() => setStep("bucket"), 180);
                        }}
                        className={cn(
                          "px-4 h-11 rounded-full border text-sm font-medium transition-all active:scale-[0.97]",
                          selected
                            ? "border-foreground bg-foreground text-background"
                            : "border-border bg-card hover:border-foreground/40",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setStep("bucket")}
                  className="mt-6 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Skip
                </button>
              </div>
            </motion.div>
          )}

          {step === "bucket" && (
            <motion.div
              key="bucket"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="p-6 animate-fade-in">
                <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
                  {intent === "want" ? "Step 4 of 4" : "Step 3 of 3"}
                </p>
                <h2 className="mt-1 text-2xl font-semibold">Which bucket?</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatCurrency(amt)} · {label}
                </p>
                {/*
                  Two groups rather than one list. The guessed bucket goes first under its
                  own heading, because filing a purchase and funding one are different
                  questions and running them together as a flat list is what made choosing
                  feel arbitrary. The rest follow with what each would be left with, which is
                  the comparison that does the work: it is read, not necessarily chosen, and
                  seeing `$0 → -$250` beside `Groceries $283 → $33` is the cost landing while
                  there is still time to feel it.
                */}
                <div className="mt-5 max-h-[50vh] overflow-y-auto pr-1">
                  {guess ? (
                    <>
                      <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Where this goes
                      </p>
                      <div className="mt-2">
                        <BucketOption
                          bucket={guess}
                          amount={amt}
                          onPick={() => pickBucket(guess)}
                          emphasized
                        />
                      </div>
                      <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        Or take it from
                      </p>
                      <div className="mt-2 grid gap-2">
                        {rest.map((b) => (
                          <BucketOption
                            key={b.id}
                            bucket={b}
                            amount={amt}
                            onPick={() => pickBucket(b)}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    // No guess: the label hit two categories at once, so the list keeps its
                    // own order rather than putting a coin-flip at the top where momentum
                    // would pick it.
                    <div className="grid gap-2">
                      {buckets.map((b) => (
                        <BucketOption
                          key={b.id}
                          bucket={b}
                          amount={amt}
                          onPick={() => pickBucket(b)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/*
            The disagreement, raised before the money moves.

            This is the same argument the contested card makes, shown a beat earlier because
            the engine answered while the bucket list was open. The difference is what it can
            offer: nothing has been charged, so "keep going" is a decision rather than an
            undo, and the money is still where it was.

            It is not a gate. Keeping the purchase is the first button, takes one tap, and
            costs nothing. Bucket advises; the person decides, and the only thing that has
            changed is that they get to decide knowing.
          */}
          {step === "secondThought" && preview && (
            <motion.div
              key="secondThought"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <div className="p-7">
                <div className="mx-auto h-14 w-14 rounded-full bg-accent flex items-center justify-center">
                  <Scale className="h-7 w-7 text-accent-foreground" />
                </div>

                <h2 className="mt-5 text-center text-xl font-semibold">Before you do</h2>

                <p className="mt-1.5 text-center text-sm text-muted-foreground">
                  {formatCurrency(amt)} · {label}
                  {selectedBucket ? ` · ${selectedBucket.name}` : ""}
                </p>

                <div className="mt-5 flex items-stretch gap-2">
                  <div className="flex-1 rounded-2xl border border-border bg-card px-4 py-3 text-center">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      You called it
                    </p>
                    <p className="mt-1 text-lg font-semibold capitalize">{intent}</p>
                  </div>
                  <div className="flex items-center text-muted-foreground text-sm">vs</div>
                  <div className="flex-1 rounded-2xl border-2 border-primary/40 bg-accent/40 px-4 py-3 text-center">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-primary/80">
                      Bucket thinks
                    </p>
                    <p className="mt-1 text-lg font-semibold capitalize">{preview.verdict}</p>
                  </div>
                </div>

                <blockquote className="mt-5 rounded-2xl bg-secondary/60 px-4 py-3.5 text-sm leading-relaxed text-foreground">
                  {preview.reasoning}
                </blockquote>

                {preview.attribution && (
                  <p className="mt-2.5 text-center text-[11px] leading-relaxed text-muted-foreground">
                    Screened by{" "}
                    <span className="text-foreground/75 font-medium">
                      {shortModelName(preview.attribution.screened)}
                    </span>
                    {preview.attribution.adjudicated && (
                      <>
                        , escalated to{" "}
                        <span className="text-foreground/75 font-medium">
                          {shortModelName(preview.attribution.adjudicated)}
                        </span>
                      </>
                    )}
                    {preview.attribution.provider === "token-factory" && " on Nebius Token Factory"}
                  </p>
                )}

                {preview.question && (
                  <p className="mt-5 text-center text-sm font-medium leading-relaxed">
                    {preview.question}
                  </p>
                )}

                <div className="mt-6 grid gap-2">
                  <Button
                    onClick={() => commitWithPreview(false)}
                    className="h-12 rounded-xl text-base"
                  >
                    Buy it anyway
                  </Button>
                  {preview.question && (
                    <Button
                      variant="outline"
                      onClick={() => commitWithPreview(true)}
                      className="h-12 rounded-xl text-base"
                    >
                      Let me explain
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={sleepOnIt}
                    className="h-12 rounded-xl text-base"
                  >
                    <Moon className="mr-1.5 h-4 w-4" />
                    Put it in the tray instead
                  </Button>
                </div>

                <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/80">
                  Nothing has been spent yet. Bucket is reading your own spending back to you, and
                  it can be wrong.
                </p>
              </div>
            </motion.div>
          )}

          {step === "intercept" && (
            <motion.div
              key="intercept"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <div className="p-7">
                <div className="mx-auto h-14 w-14 rounded-full bg-accent flex items-center justify-center">
                  <Moon className="h-7 w-7 text-accent-foreground" />
                </div>
                <h2 className="mt-5 text-center text-xl font-semibold">Take a beat.</h2>
                <p className="mt-2 text-center text-sm text-muted-foreground max-w-xs mx-auto">
                  This is a{" "}
                  <span className="font-medium text-foreground">{formatCurrency(amt)}</span> want.
                  Feel it for a moment — then decide.
                </p>
                <div className="mt-6 grid gap-2">
                  <Button
                    onClick={sleepOnIt}
                    className="h-12 rounded-xl text-base bg-primary hover:bg-primary/90"
                  >
                    <Moon className="mr-1.5 h-4 w-4" />
                    Sleep on it (24h)
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => bucketId && finalize(bucketId)}
                    className="h-12 rounded-xl text-base"
                  >
                    <Zap className="mr-1.5 h-4 w-4" />
                    Buy now
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {step === "askParent" && (
            <motion.div
              key="askParent"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="p-7">
                <div className="mx-auto h-14 w-14 rounded-full bg-accent flex items-center justify-center">
                  <Send className="h-6 w-6 text-accent-foreground" />
                </div>
                <h2 className="mt-5 text-center text-xl font-semibold">Over your allowance</h2>
                <p className="mt-2 text-center text-sm text-muted-foreground max-w-xs mx-auto">
                  This purchase is past your {selectedBucket?.name} limit. Want to ask a parent?
                </p>
                <div className="mt-6 grid gap-2">
                  <Button onClick={sendParentRequest} className="h-12 rounded-xl text-base">
                    <Send className="mr-1.5 h-4 w-4" />
                    Send request
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setStep("bucket")}
                    className="h-12 rounded-xl"
                  >
                    Choose another bucket
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {step === "confirm" && (
            <motion.div
              key="confirm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="p-10 text-center animate-fade-in">
                <div className="mx-auto h-16 w-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center animate-[check-pop_0.5s_ease-out]">
                  <Check className="h-8 w-8" strokeWidth={3} />
                </div>
                <h2 className="mt-5 text-xl font-semibold">Logged</h2>
                <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                  {formatCurrency(amt)} · {label}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function IntentButton({
  label,
  hint,
  color,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  color: "want" | "need";
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative h-32 rounded-2xl border-2 transition-all duration-200 active:scale-[0.97]",
        "flex flex-col items-center justify-center gap-1",
        selected
          ? "border-foreground bg-foreground text-background shadow-lg"
          : "border-border bg-card hover:border-foreground/40",
      )}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: `var(--${color})` }} />
      <span className="text-xl font-semibold">{label}</span>
      <span className={cn("text-xs", selected ? "text-background/70" : "text-muted-foreground")}>
        {hint}
      </span>
    </button>
  );
}
