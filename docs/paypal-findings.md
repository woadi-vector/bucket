# PayPal sandbox findings

What we learned wiring Bucket to PayPal, recorded as it happened. Each item was observed against
the sandbox, not taken from documentation.

## Oct 18 2026: the spike

Run by hand from PowerShell before any code was written, to answer one question: can a saved
PayPal wallet pay for a held order with no buyer present? If not, every purchase would need a
PayPal popup and the agent could not buy on its own.

| Step | Call | Result |
| --- | --- | --- |
| Save a wallet | `POST /v3/vault/setup-tokens`, buyer approves once, `POST /v3/vault/payment-tokens` | Payment token issued |
| Hold from the saved wallet | `POST /v2/checkout/orders`, `intent: AUTHORIZE`, `payment_source.paypal.vault_id` | Order `COMPLETED`, authorization `CREATED` in the same response, no redirect |
| Bucket on PayPal's record | `custom_id` on the purchase unit, read back with `GET /v2/checkout/orders/{id}` | Returned intact |
| Let go | `POST /v2/payments/authorizations/{id}/void` | `VOIDED` |
| Keep | `POST /v2/payments/authorizations/{id}/capture` | `COMPLETED` |

Answer: yes. The design stands as specified.

## The token trap

This cost most of the morning, and it is worth knowing before touching any PayPal app.

PayPal's client-credentials token lives about nine hours, and PayPal hands back **the same token**
on every request until it expires. Its permissions are fixed when it is issued. So if an app
issues a token before "Save payment methods" is switched on, every token that app returns for
the next nine hours still lacks Vault, and `POST /v3/vault/setup-tokens` answers
`403 NOT_AUTHORIZED` no matter how often the setting is saved.

How to tell: request a token and read `expires_in`. A value below 32400 is a reused token.

How to avoid it: on a new app, switch on the features you need **before** anything requests a
token. A token that has Vault lists `https://uri.paypal.com/services/vault/payment-tokens/readwrite`
in its scope.

## Smaller notes

- The create-order response omits `custom_id` unless the request sends
  `Prefer: return=representation`. The bucket id was stored all along; the default response just
  doesn't echo it. `paypal.ts` sends the header and checks the value.
- A vaulted order requires `PayPal-Request-Id`. Bucket derives it from the hold id and the action
  (`<hold>:authorize`, `<hold>:capture`, `<hold>:void`), so a retry repeats the original request
  rather than moving money twice.
- Sandbox authorizations do not expire after 29 days. Bucket enforces its own deadline and never
  relies on PayPal's.
- PayPal rejects an app name containing "PayPal".
