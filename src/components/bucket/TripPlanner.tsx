import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bucket, Trip, formatCurrency } from "@/lib/bucket-store";
import { Check, Plus, ShoppingCart, Trash2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  buckets: Bucket[];
  trip: Trip | null;
  startingBalances: Record<string, number>;
  onTripChange: (t: Trip) => void;
  onComplete: (committedTotal: number) => void;
  onDiscard: () => void;
};

export function TripPlanner({
  open,
  onOpenChange,
  buckets,
  trip,
  startingBalances,
  onTripChange,
  onComplete,
  onDiscard,
}: Props) {
  const defaultBucketId =
    buckets.find((b) => b.name.toLowerCase().includes("grocer"))?.id ?? buckets[0]?.id ?? "";

  const [bucketId, setBucketId] = useState<string>(trip?.bucketId ?? defaultBucketId);
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  // Keep local bucket in sync with active trip when reopened.
  useEffect(() => {
    if (open) {
      setBucketId(trip?.bucketId ?? defaultBucketId);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open, trip?.bucketId, defaultBucketId]);

  const items = trip?.items ?? [];
  const bucket = buckets.find((b) => b.id === bucketId);

  const total = useMemo(() => items.reduce((s, i) => s + i.price, 0), [items]);
  const checkedTotal = useMemo(
    () => items.filter((i) => i.checked).reduce((s, i) => s + i.price, 0),
    [items],
  );
  const checkedCount = items.filter((i) => i.checked).length;
  const overBy = bucket ? total - bucket.balance : 0;
  const isOver = overBy > 0;

  const ensureTrip = (updater: (t: Trip) => Trip) => {
    const base: Trip = trip ?? { bucketId, items: [] };
    onTripChange(updater(base));
  };

  const addItem = () => {
    const name = itemName.trim();
    if (!name) return;
    const price = parseFloat(itemPrice);
    const safePrice = isNaN(price) || price < 0 ? 0 : price;
    ensureTrip((t) => ({
      bucketId,
      items: [...t.items, { id: crypto.randomUUID(), name, price: safePrice, checked: false }],
    }));
    setItemName("");
    setItemPrice("");
    nameRef.current?.focus();
  };

  const toggleItem = (id: string) => {
    ensureTrip((t) => ({
      ...t,
      items: t.items.map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)),
    }));
  };

  const removeItem = (id: string) => {
    ensureTrip((t) => ({ ...t, items: t.items.filter((i) => i.id !== id) }));
  };

  const changeBucket = (id: string) => {
    setBucketId(id);
    if (trip) onTripChange({ ...trip, bucketId: id });
  };

  const canComplete = checkedCount > 0 && checkedTotal > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ShoppingCart className="h-5 w-5 text-primary" />
            Plan a trip
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Decide what this trip costs before you walk in.
          </p>
        </DialogHeader>

        {/* Bucket picker */}
        <div className="px-6">
          <div className="flex flex-wrap gap-1.5">
            {buckets.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => changeBucket(b.id)}
                className={cn(
                  "h-8 rounded-full px-3 text-xs font-medium border transition-colors",
                  b.id === bucketId
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:text-foreground",
                )}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>

        {/* Running total against bucket */}
        <div className="mt-4 mx-6 rounded-2xl border border-border bg-secondary/40 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Trip total
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {bucket ? `of ${formatCurrency(bucket.balance)} ${bucket.name}` : ""}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <motion.span
              key={total}
              initial={{ scale: 1.06 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 18 }}
              className={cn(
                "text-3xl font-semibold tabular-nums",
                isOver ? "text-destructive" : "text-foreground",
              )}
            >
              {formatCurrency(total)}
            </motion.span>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">
                · {items.length} item{items.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {bucket && bucket.balance > 0 && (
            <div className="mt-3 h-1.5 w-full rounded-full bg-background overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  isOver ? "bg-destructive" : "bg-primary/80",
                )}
                style={{
                  width: `${Math.min(100, (total / bucket.balance) * 100)}%`,
                }}
              />
            </div>
          )}
          <AnimatePresence>
            {isOver && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 flex items-start gap-2 text-xs text-destructive"
              >
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  This trip puts you {formatCurrency(overBy)} over {bucket?.name}. Adjust before you
                  go.
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Add item row */}
        <div className="px-6 pt-4">
          <div className="flex gap-2">
            <Input
              ref={nameRef}
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addItem();
                }
              }}
              placeholder="Add an item"
              className="h-11 rounded-xl flex-1"
            />
            <Input
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addItem();
                }
              }}
              type="number"
              inputMode="decimal"
              placeholder="$"
              className="h-11 w-20 rounded-xl tabular-nums"
            />
            <Button
              onClick={addItem}
              disabled={!itemName.trim()}
              className="h-11 rounded-xl px-3"
              aria-label="Add item"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Items */}
        <div className="px-6 pt-3 pb-2 max-h-[40vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Your list is empty. Add what you plan to buy.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border bg-card overflow-hidden">
              <AnimatePresence initial={false}>
                {items.map((i) => (
                  <motion.li
                    key={i.id}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.18 }}
                    className="flex items-center gap-3 px-3.5 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => toggleItem(i.id)}
                      className={cn(
                        "h-6 w-6 rounded-md border flex items-center justify-center transition-colors shrink-0",
                        i.checked
                          ? "bg-primary border-primary text-primary-foreground"
                          : "bg-background border-border hover:border-primary/60",
                      )}
                      aria-label={i.checked ? "Uncheck" : "Check"}
                    >
                      {i.checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                    </button>
                    <span
                      className={cn(
                        "flex-1 text-sm truncate",
                        i.checked && "line-through text-muted-foreground",
                      )}
                    >
                      {i.name}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground w-16 text-right">
                      {i.price > 0 ? formatCurrency(i.price) : "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeItem(i.id)}
                      className="text-muted-foreground/60 hover:text-destructive transition-colors p-1"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-secondary/30 px-6 py-4 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {checkedCount > 0 ? (
              <>
                <span className="font-medium text-foreground tabular-nums">
                  {formatCurrency(checkedTotal)}
                </span>{" "}
                · {checkedCount} checked
              </>
            ) : (
              "Check items off as you shop"
            )}
          </div>
          <div className="flex gap-2">
            {items.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  onDiscard();
                  onOpenChange(false);
                }}
                className="h-10 rounded-xl"
              >
                Discard
              </Button>
            )}
            <Button
              onClick={() => {
                if (!canComplete) {
                  onOpenChange(false);
                  return;
                }
                onComplete(checkedTotal);
              }}
              disabled={items.length === 0}
              className="h-10 rounded-xl px-4"
            >
              {canComplete ? "Complete trip" : "Save list"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
