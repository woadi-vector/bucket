import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBucketActions } from "./provider";

export type DemoStep = {
  caption: string;
  target?: string | null;
  delay: number;
  action?: () => void;
};

/**
 * The scripted walkthrough a judge sees on the deployed URL.
 *
 * The step list is memoised on `actions`, which is referentially stable because every
 * action is a `useEvent` callback. That gives a step list with a fixed identity — the
 * effect below depends on it, and a changing identity would reset the timer and stall
 * the walkthrough — while each step still calls the current handler rather than a
 * closure captured on first render.
 */
export function useDemo() {
  const actions = useBucketActions();

  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const lastRunStepRef = useRef(0);

  const steps = useMemo<DemoStep[]>(
    () => [
      {
        caption: "Three buckets to live from — Groceries, Dining, Savings.",
        target: `[data-bucket-id="b1"]`,
        delay: 2600,
        action: () => actions.setTab("buckets"),
      },
      {
        caption: "Time to spend. Tap New purchase to start.",
        target: `[data-demo="new-purchase"]`,
        delay: 1900,
      },
      {
        caption: "$68 headphones — tagged a want, not a need.",
        target: null,
        delay: 2400,
        action: () => {
          actions.setPrefill({
            amount: 68,
            label: "New headphones",
            intent: "want",
            bucketId: "b2",
          });
          actions.setPurchaseOpen(true);
        },
      },
      {
        caption: "Sleep on it. Wants get a 23-hour pause.",
        target: null,
        delay: 1800,
        action: () => {
          actions.setPurchaseOpen(false);
          actions.setPrefill(null);
          actions.sleepOnIt({ amount: 68, label: "New headphones", bucketId: "b2" });
        },
      },
      {
        caption: "Pending tray — your future self decides.",
        target: `li[data-pending-id]`,
        delay: 2400,
        action: () => actions.setTab("pending"),
      },
      {
        caption: "Let it go — money flies straight into Savings.",
        target: `[data-bucket-id="b4"]`,
        delay: 2800,
        action: () => {
          const li = document.querySelector<HTMLElement>("li[data-pending-id]");
          const id = li?.dataset.pendingId;
          if (id) actions.letItGo(id, li?.getBoundingClientRect());
        },
      },
      {
        caption: "Saved by pause — every skipped want adds up.",
        target: `[data-demo="saved"]`,
        delay: 2600,
      },
      {
        caption: "Insights reveal the shape of your wanting.",
        target: `[data-demo="insights"]`,
        delay: 2800,
      },
      {
        caption: "Done. Replay anytime, at any speed.",
        target: null,
        delay: 1800,
      },
    ],
    [actions],
  );

  useEffect(() => {
    if (!active || paused) return;
    if (step < 1) return;
    if (step > steps.length) {
      setActive(false);
      setStep(0);
      lastRunStepRef.current = 0;
      return;
    }
    const current = steps[step - 1];
    if (lastRunStepRef.current !== step) {
      lastRunStepRef.current = step;
      current.action?.();
    }
    const ms = Math.max(400, current.delay / speed);
    const t = window.setTimeout(() => setStep((s) => s + 1), ms);
    return () => window.clearTimeout(t);
  }, [active, paused, step, speed, steps]);

  const play = useCallback(() => {
    if (active) return;
    actions.resetAll();
    lastRunStepRef.current = 0;
    setSpeed(1);
    setPaused(false);
    setStep(1);
    setActive(true);
  }, [active, actions]);

  const exit = useCallback(() => {
    setActive(false);
    setPaused(false);
    setStep(0);
    lastRunStepRef.current = 0;
  }, []);

  const currentStep = active && step > 0 ? steps[Math.min(step, steps.length) - 1] : null;

  return {
    active,
    step: Math.min(step, steps.length),
    total: steps.length,
    caption: currentStep?.caption ?? "",
    target: currentStep?.target ?? null,
    paused,
    speed,
    setSpeed,
    togglePaused: useCallback(() => setPaused((p) => !p), []),
    play,
    exit,
  };
}
