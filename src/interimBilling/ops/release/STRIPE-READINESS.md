<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Stripe permission and retry review — 2026-11-17

The owner deferred further admin SSH-key replacement and requested Stripe
permission/retry checks. The review itself did not authorize activation or live
invoice, customer, payment method or charge creation. The subsequent separately
approved [manual activation](ACTIVATION-2026-11-18.md) is now complete.

## Verified API access

The saved restricted live key was loaded directly into the SDK at runtime.
The account was pinned to `acct_1UcfhXLodvRQZljj`. All requests in this review
were GET requests; no secret or returned customer/payment data was printed.

| Resource          | Read access checked | Write access needed by the module                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------------ |
| Customers         | Allowed             | Yes; owner confirmed Write on 2026-11-18                                 |
| Checkout Sessions | Allowed             | Yes; owner confirmed Write on 2026-11-18                                 |
| Invoices          | Allowed             | Yes, including finalization/payment; owner confirmed Write on 2026-11-18 |
| Invoice Items     | Allowed             | Yes; owner confirmed Write on 2026-11-18                                 |
| SetupIntents      | Allowed             | No direct write call                                                     |
| PaymentMethods    | Allowed             | No direct write call                                                     |
| PaymentIntents    | Allowed             | No direct write call; payment is requested through the invoice API       |
| Charges           | Allowed             | No direct write call                                                     |
| Disputes          | Allowed             | No direct write call                                                     |
| Products          | Allowed             | No direct write call; uses the existing Dispatch fee product             |
| Prices            | Allowed             | No direct Price API call; invoice items supply inline price data         |

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

The owner confirmed on 2026-11-18 that one-time invoice card retries and
ACH/local-payment retries are both off in the live Dashboard. The controls are:

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
The owner supplied both nonsecret Dashboard confirmations on 2026-11-18:
Customers, Checkout Sessions, Invoices and Invoice Items have Write permission;
automatic card retries and separate ACH retries are both off. These are
owner-confirmed settings, not direct API observations. The supported account/SDK
reads used here return neither the full key matrix nor those retry controls.

## Activation status

No live setting, permission or retry policy was changed by these checks.
The Dashboard readiness confirmations were completed, then the owner separately
approved manual activation on 2026-11-18. It is now verified; see the activation
record above. Automatic Friday run creation remains off, and each run still
requires approval of its exact invoice count and total before collection.

## Approved manual activation procedure

Completed on 2026-11-18 after explicit activation approval:

1. Set Actions secret `INTERIM_BILLING_ENABLED=true`. Leave
   `INTERIM_BILLING_AUTO_RUN=false`, live mode and the November 23 start date
   unchanged.
2. Rerun the known successful master deployment workflow `44111080462`
   (application commit `1e538e9`). It regenerates the environment with the live
   webhook secret and restarts the backend after tests pass. Subsequent local
   commits so far contain documentation only.
3. Verify enabled/live/manual flags, an empty billing ledger, healthy public
   routes, 401 for an unauthenticated admin request and 400 for an unsigned
   webhook request. If verification fails, restore the disabled configuration.
4. Do not create carriers, send setup emails, build live drafts, approve a run
   or charge anything as part of activation. Those remain separately authorized
   operator actions.
