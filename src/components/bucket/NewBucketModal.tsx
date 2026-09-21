import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (name: string, amount: number) => void;
};

export function NewBucketModal({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");

  const submit = () => {
    const n = name.trim();
    const a = parseFloat(amount);
    if (!n || isNaN(a) || a < 0) return;
    onCreate(n, a);
    setName("");
    setAmount("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle>New bucket</DialogTitle>
          <DialogDescription>Give it a name and a starting amount.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="bname">Name</Label>
            <Input id="bname" placeholder="e.g. Coffee" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bamt">Starting amount</Label>
            <Input id="bamt" type="number" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <Button onClick={submit} className="w-full h-11 rounded-xl">Create bucket</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}