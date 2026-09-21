import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, X, Rewind } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DemoStep = {
  caption: string;
  targetSelector?: string | null;
};

type Props = {
  active: boolean;
  step: number;
  total: number;
  caption: string;
  targetSelector?: string | null;
  paused: boolean;
  speed: number;
  onSpeedChange: (s: number) => void;
  onPauseToggle: () => void;
  onExit: () => void;
};

const SPEEDS = [0.5, 1, 1.5, 2] as const;

export function DemoOverlay({
  active,
  step,
  total,
  caption,
  targetSelector,
  paused,
  speed,
  onSpeedChange,
  onPauseToggle,
  onExit,
}: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!active || !targetSelector) {
      setRect(null);
      return;
    }
    let raf = 0;
    const update = () => {
      const el = document.querySelector<HTMLElement>(targetSelector);
      setRect(el ? el.getBoundingClientRect() : null);
      raf = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(raf);
  }, [active, targetSelector]);

  if (!active) return null;

  const pad = 8;

  return (
    <>
      {/* Highlight ring */}
      <AnimatePresence>
        {rect && (
          <motion.div
            key={targetSelector}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            style={{
              position: "fixed",
              left: rect.left - pad,
              top: rect.top - pad,
              width: rect.width + pad * 2,
              height: rect.height + pad * 2,
              zIndex: 70,
              pointerEvents: "none",
              borderRadius: 18,
              boxShadow:
                "0 0 0 2px oklch(0.62 0.14 165 / 0.9), 0 0 0 6px oklch(0.62 0.14 165 / 0.2), 0 12px 40px oklch(0.52 0.11 165 / 0.35)",
            }}
          >
            <motion.div
              animate={{ opacity: [0.4, 0.9, 0.4] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              style={{
                position: "absolute",
                inset: -2,
                borderRadius: 20,
                boxShadow: "0 0 24px oklch(0.62 0.14 165 / 0.55)",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom caption bar */}
      <div className="fixed inset-x-0 bottom-0 z-[80] pointer-events-none px-4 pb-4 sm:pb-6">
        <div className="mx-auto max-w-xl pointer-events-auto">
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="rounded-2xl border border-border bg-card/95 backdrop-blur-md shadow-[0_12px_40px_oklch(0_0_0/0.18)] overflow-hidden"
          >
            <div className="px-4 pt-3 pb-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <span>Demo</span>
                  <span>·</span>
                  <span>
                    Step {step} of {total}
                  </span>
                </div>
                <AnimatePresence mode="wait">
                  <motion.p
                    key={caption}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.2 }}
                    className="mt-1 text-sm font-medium text-foreground leading-snug"
                  >
                    {caption}
                  </motion.p>
                </AnimatePresence>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={onPauseToggle}
                  aria-label={paused ? "Resume" : "Pause"}
                >
                  {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={onExit}
                  aria-label="Exit demo"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {/* Speed control */}
            <div className="px-4 pb-3 flex items-center gap-2">
              <Rewind className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">Speed</span>
              <div className="ml-auto inline-flex rounded-lg bg-secondary p-0.5">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => onSpeedChange(s)}
                    className={
                      "h-6 px-2 rounded-md text-[11px] font-semibold tabular-nums transition-colors " +
                      (speed === s
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-1 bg-secondary">
              <motion.div
                className="h-full bg-primary"
                animate={{ width: `${(step / total) * 100}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </>
  );
}
