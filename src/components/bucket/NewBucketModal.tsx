import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { BucketTag } from "@/lib/bucket-store";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (name: string, amount: number, tag: BucketTag) => void;
};

export function NewBucketModal({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [tag, setTag] = useState<BucketTag>("want");

  const submit = () => {
    const n = name.trim();
    const a = parseFloat(amount);
    if (!n || isNaN(a) || a < 0) return;
    onCreate(n, a, tag);
    setName("");
    setAmount("");
    setTag("want");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle>New bucket</DialogTitle>
          <DialogDescription>
            Give it a name, a starting amount, and decide now what it is for.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="bname">Name</Label>
            <Input
              id="bname"
              placeholder="e.g. Coffee"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bamt">Starting amount</Label>
            <Input
              id="bamt"
              type="number"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>This bucket is for</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {(["need", "want"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tag === t}
                  onClick={() => setTag(t)}
                  className={
                    "rounded-xl border px-3 py-2.5 text-left transition-colors " +
                    (tag === t
                      ? "border-primary bg-accent/50"
                      : "border-border hover:bg-secondary/60")
                  }
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium capitalize">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: `var(--${t})` }}
                    />
                    {t}s
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t === "need"
                      ? "Passes, unless something reads like a want."
                      : "Anything over the threshold waits a day."}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Bucket holds every purchase to this call, including the ones your agent makes.
            </p>
          </div>
          <Button onClick={submit} className="w-full h-11 rounded-xl">
            Create bucket
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
