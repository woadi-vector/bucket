import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  Check,
  Loader2,
  Lock,
  MessageCircleWarning,
  Search,
  ShieldQuestion,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/bucket-store";
import { shopWithAgent, type ShopResult } from "@/lib/bucket/shop-fns";

type Props = {
  /** A purchase PayPal captured straight away (a need, or a small want). */
  onCaptured: (result: Extract<ShopResult, { ok: true }>) => void;
  /** A purchase now waiting as a PayPal hold. */
  onHeld: (result: Extract<ShopResult, { ok: true }>) => void;
};

/**
 * Sends the shopping agent out. The card then shows each step the purchase passed through, in
 * order, so the person sees why it was held or why it went through: what the agent picked and
 * where it filed it, what the screen thought, what the rule decided, and the PayPal record.
 */
export function AgentShop({ onCaptured, onHeld }: Props) {
  const [request, setRequest] = useState("");
  const [max, setMax] = useState("90");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShopResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = request.trim();
    const dollars = Number(max);
    if (text.length < 2 || !Number.isFinite(dollars) || dollars <= 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await shopWithAgent({
        data: { request: text, maxPriceCents: Math.round(dollars * 100) },
      });
      setResult(r);
      if (r.ok && r.hold.state === "captured") onCaptured(r);
      else if (r.ok) onHeld(r);
    } catch (e) {
      console.error("[shop] request failed", e);
      setError("The agent could not finish that request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8 rounded-2xl border border-border bg-card p-5" data-demo="agent">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-xl bg-accent flex items-center justify-center">
          <Bot className="h-4 w-4 text-accent-foreground" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Send your agent shopping</h2>
          <p className="text-xs text-muted-foreground">
            It buys with your PayPal. Bucket decides whether the money actually moves.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label="What to buy"
          placeholder="e.g. running shoes"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          className="h-11 rounded-xl sm:flex-1"
          maxLength={200}
        />
        <div className="flex gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              under $
            </span>
            <Input
              aria-label="Price ceiling in dollars"
              type="number"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              className="h-11 w-36 rounded-xl pl-[4.25rem]"
              min={1}
              max={500}
            />
          </div>
          <Button
            type="submit"
            disabled={busy || request.trim().length < 2}
            className="h-11 rounded-xl px-5"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span className="ml-1.5">{busy ? "Shopping…" : "Shop"}</span>
          </Button>
        </div>
      </form>

      <AnimatePresence mode="wait">
        {error && (
          <motion.p
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-4 text-sm text-destructive"
          >
            {error}
          </motion.p>
        )}
        {result && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4"
          >
            {result.ok ? <Steps result={result} /> : <NotBought result={result} />}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Catalog prices keep their cents: "$34.95", not the app's rounded "$35". */
const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

function NotBought({ result }: { result: Extract<ShopResult, { ok: false }> }) {
  const declined = result.reason === "declined";
  return (
    <div className="rounded-xl bg-secondary/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <X className="h-3 w-3" />
        {result.overruled
          ? "Second check overruled the agent"
          : declined
            ? "The agent bought nothing"
            : "Not bought"}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed">{result.message}</p>
      {declined && result.considered !== undefined && (
        <p className="mt-1 text-xs text-muted-foreground">
          It looked at {result.considered} listings. Nothing reached PayPal.
        </p>
      )}
      {declined && result.options && result.options.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            See what it looked at
          </summary>
          <ul className="mt-2 space-y-1.5">
            {result.options.map((o, i) => (
              <li key={i} className="leading-snug">
                <span className="font-medium">{o.title}</span>{" "}
                <span className="text-muted-foreground">
                  {cents(o.priceCents)} · {o.merchant}
                  {o.category ? ` · ${o.category}` : " · no category"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Steps({ result }: { result: Extract<ShopResult, { ok: true }> }) {
  const { product, bucket, agent, screen, policy, hold } = result;
  const held = hold.state === "held";
  return (
    <ol className="space-y-2.5">
      <Step label={`Found · ${result.considered} listings`}>
        <span className="font-medium">{product.title}</span>{" "}
        <span className="text-muted-foreground">
          {cents(product.priceCents)} · {product.merchant}
        </span>
        {product.category && (
          <div className="text-xs text-muted-foreground">{product.category}</div>
        )}
      </Step>
      <Step label={`Agent filed it under${result.models.agent ? ` · ${result.models.agent}` : ""}`}>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: `var(--${bucket.tag})` }}
          />
          {bucket.name}
        </span>{" "}
        <span className="text-muted-foreground">({bucket.tag})</span>
        {agent.reason && <div className="text-xs text-muted-foreground">{agent.reason}</div>}
      </Step>
      <Step label={`Second check${result.models.check ? ` · ${result.models.check}` : ""}`}>
        {result.check.ran ? (
          <>
            <span className="font-medium">Confirmed it is what you asked for.</span>
            {result.check.reason && (
              <div className="text-xs text-muted-foreground">{result.check.reason}</div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Not run. {result.check.why}</span>
        )}
      </Step>
      <Step
        label={`Screen${screen.ran && screen.model ? ` · ${screen.model}` : ""}`}
        icon={<ShieldQuestion className="h-3 w-3" />}
      >
        {screen.ran ? (
          <>
            <span className="font-medium">
              {screen.withheld
                ? "No doubt strong enough to raise."
                : screen.agrees
                  ? "Reads like a need."
                  : "Reads like a want."}
            </span>
            {screen.reasoning && (
              <div className="text-xs text-muted-foreground">{screen.reasoning}</div>
            )}
            {!screen.agrees && screen.question && (
              <div className="mt-1 text-xs italic">“{screen.question}”</div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            Skipped. A want bucket is decided by its own threshold (
            {formatCurrency(bucket.holdThresholdCents / 100)}).
          </span>
        )}
      </Step>
      {bucket.tag === "want" && (
        <Step label="Pushback" icon={<MessageCircleWarning className="h-3 w-3" />}>
          {result.pushback.length > 0 ? (
            <ul className="space-y-1">
              {result.pushback.map((reason, i) => (
                <li key={i} className="font-medium">
                  {reason}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">
              Checked your balance and recent purchases. Nothing to push back on.
            </span>
          )}
        </Step>
      )}
      <Step label="Rule · code, no model">
        <span className="font-medium">{policy.reason}</span>
      </Step>
      <li
        className={
          "rounded-xl px-4 py-3 " +
          (held ? "bg-primary/10 border border-primary/30" : "bg-accent/50")
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
            {held ? <Lock className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            {held ? "Held at PayPal" : "Paid with PayPal"}
          </span>
          <code className="text-xs font-mono">{hold.authorizationId}</code>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {held
            ? "The money is reserved, not taken. Keep it or let it go from the PayPal tab before the clock runs out."
            : "Captured straight away."}
        </p>
      </li>
      {result.models.provider && (
        <li className="px-1 text-[11px] text-muted-foreground">
          Models served by {result.models.provider}. The rule and the PayPal calls are code.
        </li>
      )}
    </ol>
  );
}

function Step({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-xl bg-secondary/40 px-4 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm leading-relaxed">{children}</div>
    </li>
  );
}
