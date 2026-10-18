import { getEnvVar, getSecret } from "@/lib/server-env";

/**
 * PayPal REST client: the four calls Bucket needs and nothing more.
 *
 * Server-only. It holds the client secret, so nothing that reaches the browser may import it,
 * and it is deliberately not exposed as a tool to any model: `payments.ts` is its only caller.
 *
 * Plain `fetch`, no SDK, because server code runs in the Workers runtime. Every call below was
 * run by hand against the sandbox on Oct 18 2026 before it was written down here: a saved
 * PayPal wallet funded an AUTHORIZE order with no buyer present, the bucket id came back on the
 * order record, and both void and capture completed.
 */

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
export const LIVE_BASE = "https://api-m.paypal.com";

/** A PayPal API failure, with the fields worth logging and nothing secret. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly paypalName: string | null,
    readonly debugId: string | null,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

/** Thrown before any network call when the credentials are not configured. */
export class PayPalNotConfigured extends Error {
  constructor() {
    super("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    this.name = "PayPalNotConfigured";
  }
}

type Config = { clientId: string; secret: string; base: string };

/**
 * Sandbox unless PAYPAL_ENV is exactly "live". The hackathon runs on the sandbox, and a typo in
 * an environment variable must never be the thing that points Bucket at real money.
 */
function config(): Config {
  const clientId = getSecret("PAYPAL_CLIENT_ID");
  const secret = getSecret("PAYPAL_CLIENT_SECRET");
  if (!clientId || !secret) throw new PayPalNotConfigured();
  const base = getEnvVar("PAYPAL_ENV") === "live" ? LIVE_BASE : SANDBOX_BASE;
  return { clientId, secret, base };
}

// --- Access token --------------------------------------------------------------------------

type CachedToken = { token: string; expiresAt: number; clientId: string };

/**
 * One token per isolate, refreshed a minute before it expires.
 *
 * PayPal itself reuses a token for up to nine hours and hands back the same one on every
 * request, so asking more often buys nothing. The spike found the sharp edge in that: a token
 * issued before a feature is switched on never gains the feature. Scopes are fixed at issue.
 * See docs/paypal-findings.md.
 */
function tokenCache(): { current?: CachedToken } {
  const g = globalThis as { __bucketPayPalToken?: { current?: CachedToken } };
  if (!g.__bucketPayPalToken) g.__bucketPayPalToken = {};
  return g.__bucketPayPalToken;
}

async function accessToken(cfg: Config): Promise<string> {
  const cache = tokenCache();
  const now = Date.now();
  const cached = cache.current;
  if (cached && cached.clientId === cfg.clientId && cached.expiresAt - 60_000 > now) {
    return cached.token;
  }

  const basic = btoa(`${cfg.clientId}:${cfg.secret}`);
  const response = await fetch(`${cfg.base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw await toError(response, "token request failed");

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new PayPalError("token response had no token", 502, null, null);

  cache.current = {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 0) * 1000,
    clientId: cfg.clientId,
  };
  return body.access_token;
}

// --- Request plumbing ----------------------------------------------------------------------

async function toError(response: Response, context: string): Promise<PayPalError> {
  let name: string | null = null;
  let debugId: string | null = null;
  let detail = "";
  try {
    const body = (await response.json()) as {
      name?: string;
      debug_id?: string;
      message?: string;
      details?: { issue?: string }[];
    };
    name = body.name ?? null;
    debugId = body.debug_id ?? null;
    const issue = body.details?.[0]?.issue;
    detail = [body.message, issue].filter(Boolean).join(": ");
  } catch {
    // Not JSON. The status alone still says enough to act on.
  }
  return new PayPalError(
    `PayPal ${context} (${response.status}${name ? ` ${name}` : ""})${detail ? `: ${detail}` : ""}`,
    response.status,
    name,
    debugId,
  );
}

/**
 * One authenticated call.
 *
 * `requestId` becomes PayPal-Request-Id, PayPal's idempotency key. Retrying a call with the
 * same id returns the first result instead of moving money twice, so every money-moving call
 * passes one.
 */
async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; requestId?: string; representation?: boolean } = {},
): Promise<T> {
  const cfg = config();
  const token = await accessToken(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  if (opts.representation) headers.Prefer = "return=representation";

  const response = await fetch(`${cfg.base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!response.ok) throw await toError(response, `${method} ${path.split("?")[0]} failed`);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// --- Money -----------------------------------------------------------------------------------

/** Integer cents to PayPal's decimal string. Rejects anything that is not a positive integer. */
export function formatAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new RangeError(`amount must be a positive whole number of cents, got ${cents}`);
  }
  return (cents / 100).toFixed(2);
}

export type AuthorizedOrder = {
  orderId: string;
  authorizationId: string;
  /** PayPal's own expiry for the authorization (29 days). Bucket's deadline is far shorter. */
  paypalExpiresAt: string | null;
};

type OrderResponse = {
  id: string;
  status: string;
  purchase_units?: {
    custom_id?: string;
    payments?: {
      authorizations?: { id: string; status: string; expiration_time?: string }[];
    };
  }[];
};

/**
 * Creates an order paid from a saved wallet and returns the hold PayPal placed.
 *
 * With `payment_source.paypal.vault_id` PayPal completes the order immediately: there is no
 * buyer redirect, and the response already carries the authorization. That is what lets an
 * agent buy on the person's behalf. The bucket id rides on the order as `custom_id`, so it is
 * part of PayPal's record, not only ours, and it is checked on the way back.
 */
export async function createAuthorizedOrder(args: {
  vaultId: string;
  amountCents: number;
  currency?: string;
  bucketId: string;
  description: string;
  requestId: string;
}): Promise<AuthorizedOrder> {
  const order = await call<OrderResponse>("POST", "/v2/checkout/orders", {
    requestId: args.requestId,
    representation: true,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: args.bucketId.slice(0, 127),
          description: args.description.slice(0, 127),
          amount: { currency_code: args.currency ?? "USD", value: formatAmount(args.amountCents) },
        },
      ],
      payment_source: { paypal: { vault_id: args.vaultId } },
    },
  });

  const unit = order.purchase_units?.[0];
  const authorization = unit?.payments?.authorizations?.[0];
  if (order.status !== "COMPLETED" || !authorization) {
    // The case the spike was run to rule out: the saved wallet did not fund the order on its
    // own. Surfacing it loudly beats recording a hold that does not exist.
    throw new PayPalError(
      `order ${order.id} did not produce a hold (status ${order.status})`,
      502,
      null,
      null,
    );
  }
  if (unit?.custom_id !== undefined && unit.custom_id !== args.bucketId.slice(0, 127)) {
    throw new PayPalError(`order ${order.id} came back with the wrong bucket`, 502, null, null);
  }

  return {
    orderId: order.id,
    authorizationId: authorization.id,
    paypalExpiresAt: authorization.expiration_time ?? null,
  };
}

/** Takes the held money. Returns PayPal's capture id. */
export async function captureAuthorization(
  authorizationId: string,
  requestId: string,
): Promise<{ captureId: string; status: string }> {
  const capture = await call<{ id: string; status: string }>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    { requestId, body: {} },
  );
  return { captureId: capture.id, status: capture.status };
}

/** Releases the held money. All or nothing; PayPal has no partial void. */
export async function voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
  await call<void>(
    "POST",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    { requestId },
  );
}

/** PayPal's current view of a hold: CREATED, CAPTURED, VOIDED, EXPIRED and so on. */
export async function getAuthorizationStatus(authorizationId: string): Promise<string> {
  const auth = await call<{ status: string }>(
    "GET",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
  );
  return auth.status;
}
