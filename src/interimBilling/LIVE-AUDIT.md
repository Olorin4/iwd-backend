<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Live Stripe catalog audit — 2026-11-17

The owner supplied a restricted live key for this read-only inspection.
Credentials were loaded at runtime; no key or raw Stripe error was printed.
All requests were GET requests. No live object, payment method, invoice,
account setting, webhook or application configuration was created or changed.

## Verified live state

Expected account identity was checked before reading the product:
`acct_1UcfhXLodvRQZljj` (Iron Wing Dispatching).

| Item                                        | Observed result                                 |
| ------------------------------------------- | ----------------------------------------------- |
| Account charges enabled / details submitted | Both true                                       |
| Default currency                            | USD                                             |
| Card capability                             | Active                                          |
| US bank account ACH capability              | Active                                          |
| Public support email and phone              | Match the module's configured business contacts |
| Account statement descriptor                | `IRON WING DISPATCHING`                         |
| Product                                     | `prod_VdynnoKRWNRS3t`, `Dispatch fee`           |
| Product mode and status                     | Live, active                                    |
| Product description                         | Present; mentions linehaul                      |
| Default product Price                       | Unset                                           |
| Saved product Prices                        | 0, complete paginated listing                   |
| Product unit label                          | Unset                                           |
| Product tax code                            | Unset                                           |
| Product statement descriptor                | Unset                                           |
| Product metadata                            | 2 entries; values not logged                    |
| Images / marketing features                 | Both empty                                      |

No catalog blocker was found for the module's existing invoice implementation.
An empty default Price is intentional: `addInvoiceItem` uses the product id and
its calculated per-load fee in `price_data.unit_amount`. The carrier percentage
lives in our carrier row (`fee_bp`), rather than in a fixed Stripe catalog Price.
For example, $2,400 linehaul at 500 basis points produces a $120 invoice item.
Stripe documents inline [`price_data`](https://docs.stripe.com/api/invoiceitems/create)
for this workflow.

The missing product-level descriptor does not leave module invoices without one:
`createDraftInvoice` explicitly supplies `IRON WING DISPATCH`. The live account's
longer `IRON WING DISPATCHING` label is a different account-level setting; it was
not changed. Images, marketing features and unit labels are not consumed by the
module's item creation. The module does not enable Stripe Tax; this audit does
not establish tax treatment.

## Activation and limits

At inspection time, the local billing module was disabled, mode unset, and
autorun false. Saving this credential did not activate billing or change its
mode. No application release, push, merge or deployment occurred in this audit.

This account/catalog read does not verify Dashboard-only retry or receipt-email
controls, webhook endpoint configuration, carrier payment setup, hosted Checkout
completion, ACH settlement, or real email delivery. The separate sandbox test
record establishes setup-session creation and a synthetic card invoice payment,
not those remaining end-to-end checks.

The earlier CLI account mismatch was avoided: the audit used only the saved
restricted live key and stopped unless the expected account identity matched.
The key remains a secret outside version control and is not part of this record.
