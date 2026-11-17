<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Stripe permission and retry review — 2026-11-17

The owner deferred further admin SSH-key replacement and requested Stripe
permission/retry checks. Billing remains disabled; no activation or live invoice,
customer, payment method or charge creation is authorized by this review.

## Verified API access

The saved restricted live key was loaded directly into the SDK at runtime.
The account was pinned to `acct_1UcfhXLodvRQZljj`. All requests in this review
were GET requests; no secret or returned customer/payment data was printed.

| Resource          | Read access checked | Write access needed by the module                                   |
| ----------------- | ------------------- | ------------------------------------------------------------------- |
| Customers         | Allowed             | Yes; Dashboard confirmation pending                                 |
| Checkout Sessions | Allowed             | Yes; Dashboard confirmation pending                                 |
| Invoices          | Allowed             | Yes, including finalization/payment; Dashboard confirmation pending |
| Invoice Items     | Allowed             | Yes; Dashboard confirmation pending                                 |
| SetupIntents      | Allowed             | No direct write call                                                |
| PaymentMethods    | Allowed             | No direct write call                                                |
| PaymentIntents    | Allowed             | No direct write call; payment is requested through the invoice API  |
| Charges           | Allowed             | No direct write call                                                |
| Disputes          | Allowed             | No direct write call                                                |
| Products          | Allowed             | No direct write call; uses the existing Dispatch fee product        |
| Prices            | Allowed             | No direct Price API call; invoice items supply inline price data    |

Read success establishes resource read access only. It does not establish write
scope. The earlier successful live webhook creation established webhook write
access, not invoice/customer write access. We did not create disposable live
objects or submit intentionally invalid mutation requests as permission probes.
The current connection has no authenticated Dashboard session for inspecting
the full key permission matrix.

Confirm in the **live** Iron Wing account: [API keys](https://dashboard.stripe.com/apikeys)
→ the saved billing restricted key → edit permissions. Customers, Checkout
Sessions, Invoices and Invoice Items need Write; the other directly retrieved
resources need Read. Do not reveal or copy a key into chat. Stripe's
[restricted-key guide](https://docs.stripe.com/keys/restricted-api-keys) maps GET
to Read and POST/DELETE to Write and describes reviewing the integration's API
usage. Write implies Read for that resource. This is a resource-level review,
not a claim that every possible nested operation has been exercised live.

## Retry ownership

The module sets `auto_advance: false` at both invoice creation and finalization.
Stripe's [automatic advancement documentation](https://docs.stripe.com/invoicing/integration/automatic-advancement-collection)
states that invoice retry charges, retry emails and automatic collection are
disabled when automatic advancement is off; configurable receipts remain separate.
Our worker owns initial payment, immediate backup and +1/+3 US business-day
retry rounds. A processing ACH debit never triggers the backup or another retry.

The known sandbox exhausted-decline and pending-ACH invoices were refetched to
check `auto_advance=false` and `next_payment_attempt=null`. These are sandbox
invoice-level observations; they do not read the live account's retry toggles.

Account settings still need explicit confirmation in the live Dashboard:

1. **One-time invoice card retries:** Settings → Billing →
   [Invoices](https://dashboard.stripe.com/settings/billing/invoice) → Advanced
   invoicing features. Automatic payment retries must be off for this module's
   intended account configuration.
2. **ACH/local-payment retries:** check the applicable ACH Direct Debit retry
   control separately. Disable automatic debit retries; the module owns its own
   schedule. Checking only card retries does not establish this setting.
3. **Subscription retries:** the [Revenue recovery retry page](https://dashboard.stripe.com/revenue_recovery/retries)
   is a separate control. The module creates one-time invoices, not subscriptions;
   do not change unrelated subscription policies as part of this review.

These distinct controls are documented in Stripe's
[payment retry guide](https://docs.stripe.com/billing/revenue-recovery/smart-retries).
The handoff reported retries off; this review has not refreshed that observation
through an authenticated Dashboard. The supported account/SDK reads used here
return neither the full key matrix nor these account retry controls. The owner
was asked for the two nonsecret Dashboard confirmations; neither is inferred
from successful GET requests or from the webhook registration.

## Activation status

No live setting, permission or retry policy was changed by these checks.
Billing remains disabled. After the Dashboard confirmations, record exactly
what the owner confirmed, then review manual activation separately. Automatic
Friday run creation remains off, and each run still requires approval of the
exact invoice count and total before collection.
