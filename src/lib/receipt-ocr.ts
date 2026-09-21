/**
 * Stubbed receipt OCR. Swap the body for a real provider (Veryfi, Taggun,
 * Google ML Kit) when credentials are wired. The UI contract stays the same.
 */
export type ParsedReceipt = {
  merchant: string;
  total: number; // 0 when unreadable
  date: string; // ISO
  confidence: number; // 0..1
};

const SAMPLE_MERCHANTS = [
  "Whole Foods Market",
  "Trader Joe's",
  "Blue Bottle Coffee",
  "Chipotle",
  "Target",
  "CVS Pharmacy",
  "Shell Gas",
  "Sweetgreen",
];

export async function parseReceipt(_file: File): Promise<ParsedReceipt> {
  // Simulate network/inference latency
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));

  // ~12% of the time, "fail" so we can demo the graceful fallback.
  const failed = Math.random() < 0.12;
  if (failed) {
    return {
      merchant: "",
      total: 0,
      date: new Date().toISOString(),
      confidence: 0.2,
    };
  }

  const merchant =
    SAMPLE_MERCHANTS[Math.floor(Math.random() * SAMPLE_MERCHANTS.length)];
  // Realistic-looking totals
  const total = Math.round((4 + Math.random() * 95) * 100) / 100;

  return {
    merchant,
    total,
    date: new Date().toISOString(),
    confidence: 0.78 + Math.random() * 0.2,
  };
}