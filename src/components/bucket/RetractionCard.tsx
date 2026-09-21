import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Transaction, formatCurrency } from "@/lib/bucket-store";
import { Moon, Scale } from "lucide-react";
import { motion } from "framer-motion";

type Props = {
  transaction: Transaction | null;
  bucketName: string | undefined;
  onRetract: () => void;
  onOverride: () => void;
  onDismiss: () => void;
};

/**
 * The moment Bucket says it disagrees with you.
 *
 * Two rules shape everything here. Bucket advises and can be overridden, so "Keep it" is a
 * real, unpunished choice and the copy never scolds. And Bucket does not predict — it argues
 * from what you have already done, which is why the model's reasoning is quoted rather than
 * summarised into a score.
 *
 * It appears seconds after the purchase was logged, because the model is not fast enough to
 * ask beforehand. That is why it offers to pull the purchase back rather than pretending it
 * caught it in time.
 */
export function RetractionCard({
  transaction,
  bucketName,
  onRetract,
  onOverride,
  onDismiss,
}: Props) {
  const verdict = transaction?.verdict;
  const open = Boolean(transaction && verdict && !verdict.agrees);

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
            <div className="mx-auto h-14 w-14 rounded-full bg-accent flex items-center justify-center">
              <Scale className="h-7 w-7 text-accent-foreground" />
            </div>

            <h2 className="mt-5 text-center text-xl font-semibold">A second thought</h2>

            <p className="mt-1.5 text-center text-sm text-muted-foreground">
              {transaction.label} · {formatCurrency(transaction.amount)}
              {bucketName ? ` · ${bucketName}` : ""}
            </p>

            {/* The disagreement, stated plainly: your word against Bucket's. */}
            <div className="mt-5 flex items-stretch gap-2">
              <div className="flex-1 rounded-2xl border border-border bg-card px-4 py-3 text-center">
                <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  You called it
                </p>
                <p className="mt-1 text-lg font-semibold capitalize">{transaction.intent}</p>
              </div>
              <div className="flex items-center text-muted-foreground text-sm">vs</div>
              <div className="flex-1 rounded-2xl border-2 border-primary/40 bg-accent/40 px-4 py-3 text-center">
                <p className="text-[10px] uppercase tracking-[0.16em] text-primary/80">
                  Bucket thinks
                </p>
                <p className="mt-1 text-lg font-semibold capitalize">{verdict.verdict}</p>
              </div>
            </div>

            <blockquote className="mt-5 rounded-2xl bg-secondary/60 px-4 py-3.5 text-sm leading-relaxed text-foreground">
              {verdict.reasoning}
            </blockquote>

            <div className="mt-6 grid gap-2">
              <Button onClick={onRetract} className="h-12 rounded-xl text-base">
                <Moon className="mr-1.5 h-4 w-4" />
                Put it back, let me sleep on it
              </Button>
              <Button variant="outline" onClick={onOverride} className="h-12 rounded-xl text-base">
                No, I meant it — keep the purchase
              </Button>
            </div>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/80">
              Bucket is reading your own spending back to you. It can be wrong, and it is your money
              either way.
            </p>
          </motion.div>
        )}
      </DialogContent>
    </Dialog>
  );
}
