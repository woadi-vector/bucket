import { getSecret } from "@/lib/server-env";

/**
 * Channel3 product search: where the shopping agent finds things to buy.
 *
 * Server-only (it holds CHANNEL3_API_KEY). Plain `fetch` for the Workers runtime. Request and
 * response shapes follow the Channel3 API reference for POST /v1/search.
 *
 * Product text from Channel3 is third-party content and it ends up in a model prompt, so this
 * module trims every field and hands back only what the agent needs to choose. Nothing a
 * product title says can move money: the agent only ever names a product and a bucket, and the
 * policy plus the payments module decide the rest.
 */

const BASE = "https://api.trychannel3.com";

export class Channel3NotConfigured extends Error {
  constructor() {
    super("Channel3 is not configured: set CHANNEL3_API_KEY");
    this.name = "Channel3NotConfigured";
  }
}

export class Channel3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Channel3Error";
  }
}

/** One buyable offer, flattened to what Bucket uses. */
export type ProductOption = {
  id: string;
  title: string;
  brand: string | null;
  /** Integer cents, from the cheapest in-stock USD offer. */
  priceCents: number;
  merchant: string;
  url: string;
  imageUrl: string | null;
};

type RawProduct = {
  id?: string;
  title?: string;
  brands?: { name?: string }[];
  images?: { url?: string; is_main_image?: boolean }[];
  offers?: {
    url?: string;
    domain?: string;
    availability?: string;
    price?: { price?: number; currency?: string };
  }[];
};

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Flattens Channel3 products to one option each, dropping anything without a USD price. */
export function toOptions(products: RawProduct[]): ProductOption[] {
  const options: ProductOption[] = [];
  for (const p of products) {
    if (!p.id || !p.title) continue;
    const offers = (p.offers ?? []).filter(
      (o) =>
        o.url &&
        o.domain &&
        o.availability !== "OutOfStock" &&
        o.price?.currency === "USD" &&
        typeof o.price.price === "number" &&
        o.price.price > 0,
    );
    if (offers.length === 0) continue;
    const best = offers.reduce((a, b) => ((a.price!.price ?? 0) <= (b.price!.price ?? 0) ? a : b));
    const image = p.images?.find((i) => i.is_main_image)?.url ?? p.images?.[0]?.url ?? null;
    options.push({
      id: clip(p.id, 80),
      title: clip(p.title, 140),
      brand: p.brands?.[0]?.name ? clip(p.brands[0].name, 60) : null,
      priceCents: Math.round((best.price!.price as number) * 100),
      merchant: clip(best.domain as string, 80),
      url: (best.url as string).slice(0, 500),
      imageUrl: image ? image.slice(0, 500) : null,
    });
  }
  return options;
}

/**
 * Searches Channel3 and returns up to `limit` buyable options, cheapest offer per product.
 * `maxPriceCents` is passed to Channel3 as a price filter and enforced again here.
 */
export async function searchProducts(args: {
  query: string;
  maxPriceCents?: number;
  limit?: number;
}): Promise<ProductOption[]> {
  const apiKey = getSecret("CHANNEL3_API_KEY");
  if (!apiKey) throw new Channel3NotConfigured();

  const limit = Math.min(Math.max(args.limit ?? 8, 1), 30);
  const body: Record<string, unknown> = { query: clip(args.query, 200), limit };
  if (args.maxPriceCents) {
    body.filters = {
      price: { max_price: args.maxPriceCents / 100 },
      availability: ["InStock"],
      conditions: ["new"],
    };
  }

  const response = await fetch(`${BASE}/v1/search`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Channel3Error(`Channel3 search failed (${response.status})`, response.status);
  }
  const data = (await response.json()) as { products?: RawProduct[] };
  const options = toOptions(data.products ?? []);
  return args.maxPriceCents
    ? options.filter((o) => o.priceCents <= (args.maxPriceCents as number))
    : options;
}
