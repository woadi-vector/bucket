import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Bucket, formatCurrency, ReadinessTag, READINESS_OPTIONS } from "@/lib/bucket-store";
import { cn } from "@/lib/utils";
import { Check, Moon, Zap, Send } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Step = "amount" | "intent" | "readiness" | "bucket" | "intercept" | "askParent" | "confirm";

export const SLEEP_THRESHOLD = 40;

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  buckets: Bucket[];
  startingBalances: Record<string, number>;
  onConfirm: (data: {
    amount: number;
    label: string;
    bucketId: string;
    intent: "want" | "need";
    readinessTag: ReadinessTag | null;
  }) => void;
  onSleepOnIt: (data: {
    amount: number;
    label: string;
    bucketId: string;
    readinessTag: ReadinessTag | null;
  }) => void;
  onParentRequest: (data: { amount: number; label: string; bucketId: string }) => void;
  /** Pre-filled values for scripted demo. */
  prefill?: { amount: number; label: string; intent?: "want" | "need"; bucketId?: string } | null;
};

export function PurchaseFlow({
  open,
  onOpenChange,
  buckets,
  startingBalances,
  onConfirm,
  onSleepOnIt,
  onParentRequest,
  prefill,
}: Props) {
  const [step, setStep] = useState<Step>("amount");
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
    }
  }, [open, prefill]);

  const amt = parseFloat(amount);
  const amtValid = !isNaN(amt) && amt > 0 && label.trim().length > 0;
  const selectedBucket = buckets.find((b) => b.id === bucketId) ?? null;

  const pickBucket = (b: Bucket) => {
    setBucketId(b.id);
    const spent = Math.max(0, startingBalances[b.id] - b.balance);
    // Child bucket over limit -> ask a parent (soft)
    if (b.ownerType === "child" && b.limit != null && spent + amt > b.limit) {
      setStep("askParent");
      return;
    }
    // Want over threshold -> sleep on it interception
    if (intent === "want" && amt > SLEEP_THRESHOLD) {
      setStep("intercept");
      return;
    }
    finalize(b.id);
  };

  const finalize = (bId: string) => {
    setStep("confirm");
    setTimeout(() => {
      onConfirm({
        amount: amt,
        label: label.trim(),
        bucketId: bId,
        intent: intent!,
        readinessTag: readiness,
      });
    }, 1000);
    setTimeout(() => onOpenChange(false), 1350);
  };

  const sleepOnIt = () => {
    if (!bucketId) return;
    onSleepOnIt({ amount: amt, label: label.trim(), bucketId, readinessTag: readiness });
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
                <div className="mt-5 grid gap-2 max-h-[50vh] overflow-y-auto pr-1">
                  {buckets.map((b) => {
                    const after = b.balance - amt;
                    const negative = after < 0;
                    return (
                      <button
                        key={b.id}
                        onClick={() => pickBucket(b)}
                        className="flex items-center justify-between gap-3 p-4 rounded-xl border border-border bg-card hover:border-primary/50 hover:bg-secondary/50 transition-all active:scale-[0.98] text-left"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="h-9 w-9 shrink-0 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: b.accent }}
                          >
                            <b.icon className="h-4 w-4 text-foreground/80" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate">{b.name}</div>
                            <div className="text-xs text-muted-foreground tabular-nums">
                              {formatCurrency(b.balance)} →{" "}
                              <span className={cn(negative && "text-destructive")}>
                                {formatCurrency(after)}
                              </span>
                            </div>
                          </div>
                        </div>
                        {b.ownerType === "child" && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground font-medium">
                            Kids
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
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
