import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { Sparkles, Info } from "lucide-react";

export function HeroSaved({ amount }: { amount: number }) {
  const [display, setDisplay] = useState(amount);
  const prev = useRef(amount);

  useEffect(() => {
    if (amount === prev.current) return;
    const start = prev.current;
    const delta = amount - start;
    const duration = 900;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(start + delta * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    if (delta > 0) {
      const fire = (origin: { x: number; y: number }) =>
        confetti({
          particleCount: 80,
          spread: 70,
          startVelocity: 38,
          origin,
          colors: ["#4caf94", "#f0c674", "#e8a87c", "#a8d5ba", "#ffffff"],
          scalar: 0.9,
        });
      fire({ x: 0.5, y: 0.35 });
      setTimeout(() => fire({ x: 0.3, y: 0.4 }), 120);
      setTimeout(() => fire({ x: 0.7, y: 0.4 }), 240);
    }

    prev.current = amount;
    return () => cancelAnimationFrame(raf);
  }, [amount]);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-accent/60 via-card to-card p-6 sm:p-7">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-[0.18em] text-primary/80">
        <Sparkles className="h-3.5 w-3.5" />
        Saved by sleeping on it
        <span
          className="ml-0.5 cursor-help"
          title='Research calls it the "pain of paying." Physical cash makes spending feel like a small loss, and that feeling makes us think twice. Cards remove that signal. Bucket re-creates it — a half-second pause that turns autopilot back into a choice.'
        >
          <Info className="h-3.5 w-3.5 opacity-50" />
        </span>
      </div>
      <motion.div
        key={amount}
        initial={{ scale: amount > 0 && display !== amount ? 1.08 : 1 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 16 }}
        className="mt-2 text-5xl sm:text-6xl font-semibold tabular-nums tracking-tight text-foreground"
      >
        ${display.toLocaleString("en-US")}
      </motion.div>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Every dollar you let go of stays yours.
      </p>
    </div>
  );
}
