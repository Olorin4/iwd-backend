<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Implementation and review record — 2026-11-17

Tasks 6–13 were implemented in separate local commits on
`feat/interim-weekly-billing`. A fresh `gpt-6-astra` reviewer inspected the
whole branch `59dc5bd..830ea9e` read-only. The implementer then performed one
regression-driven fix pass. During that initial build nothing was pushed, merged,
deployed or applied to a production server; the later approved reader
installation is recorded below. The untracked handoff directory was preserved.

## Review findings

| Finding                                                                       | Resolution and regression evidence                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical: interrupted build could approve 12000 cents while Stripe held 24000 | Persist membership/totals atomically, recompute on rebuild, compare complete Stripe amount/customer/currency/metadata and paginated per-line fees before payment. Changing-membership and amount-mismatch tests failed before the fix and pass afterwards.                 |
| Important: resolving lines before approval waited another week                | POST `/runs` refreshes the current unapproved drafts; approval refuses pending unassigned ready lines. Approved runs remain frozen. Regression passed after first failing.                                                                                                 |
| Important: paid invoice could hide a verified late failure                    | A current failed intent with an error and matching stored intent id alerts without retry; a stale decline followed by current success does not alert. Regression failed then passed. Actual bank-return event shapes remain unverified.                                    |
| Important: undated cancellations were absent from reader output               | Explicit SQL reporting branch includes cancelled rows with null cancellation timestamp. Classifier still never charges them. SQL guard regression failed then passed. Production SQL was unapplied at that review; the subsequent approved installation is recorded below. |
| Important: summary/final-failure mail could be lost after a crash             | Durable `summary_pending` and `failed_notifying` states retry delivery through recovery/worker. Notification and scheduler regressions failed then passed. Delivery is at least once; uncertain delivery may duplicate email.                                              |
| Important: asset ownership dates were ignored                                 | Apply `effective_from` at each load occurrence; accept optional validated UTC `effectiveFrom` at onboarding, defaulting to configured billing start for backlog. Date regressions failed then passed.                                                                      |
| Reported minor: README relative links                                         | Declined as factually incorrect: `src/interimBilling/../../docs` resolves to the existing repository docs. Changing it to `../../../docs` would leave the repository.                                                                                                      |

The fix pass also repaired existing-draft dry-run summaries after a regression
showed that held lines were omitted. No reviewer minor was deferred.

## Verified

- Node 22.20.0; dependencies installed and Prisma client generated.
- Final `npm test`: 30 suites, **301 tests passed**.
- Final `npm run test:integration`: 2 suites, **19 tests passed**.
- `npx eslint src/interimBilling` and `git diff --check`: passed.
- Guarded real Stripe **sandbox** API: synthetic customer, draft, attached
  invoice item, metadata reconciliation, finalization and successful test-token
  card payment. Invoice `in_1UclH5Lbp6WU1kVScbXVBnGg` was subsequently refetched
  to verify the new total/identity/full-membership guard against real responses.
- Sandbox account-id and test-key-prefix checks ran before these API calls.
  Only synthetic carrier data was submitted; no module emails were sent.

## Initial sandbox gate (resolved for session creation)

At the initial review, Checkout session creation was not working in the tested sandbox. Combined card/ACH
setup and an independent minimal card-only request were rejected on
`payment_method_types`. No account settings were changed. Capability/config
reads reported active card and ACH capabilities, available/on payment methods,
and charges enabled. This does not establish the reason for the rejection.

Inspect **Stripe sandbox → Developers/Workbench → Logs →
POST /v1/checkout/sessions**, including request `req_knpVMFV1X3vAPF`.
No raw Stripe message, key or personal information was printed in the tests.
Hosted setup, ACH verification/settlement, actual late-return event shapes,
and real email delivery remain unverified. Follow [SANDBOX-TEST.md](SANDBOX-TEST.md)
to finish hosted completion and ACH verification. Keep the module off until then;
this branch is not ready for live activation.

## External follow-ups from the owner handoff

These were not started or refreshed as part of this implementation:

- Closed on follow-up: approval and installation of production reader SQL/script,
  real organization/database placeholders and dedicated key pair.
- Add new CI secrets before a future approved deploy; the workflow regenerates
  the server environment file. Rotate the previously exposed deployment key.
- E-signature pack needs its own design and sandbox validation; no signature
  service or production onboarding was added here.
- Jack real-call lead emails, Twilio call-price coverage, the unpushed Kelevo
  WebSocket change and the unused twilio-app stash remain separate threads.

## Rulings preserved from the execution ledger

- Setup: Ruling: work in place on a feature branch instead of a separate worktree — the plan names the branch, the owner chose inline execution, and the repo's only other uncommitted state was the two docs committed first — if wrong, switching branches loses nothing.

- Task 2: Ruling: describeLine also accepts an optional kelevoLoadId, used as 'id <n>' when the load has no number — the plan's signature has no id and a numberless load would otherwise print 'Load null' — if wrong, one fallback line.

- Task 4: Ruling: edited **tests**/setup-integration.js (a sixth hook, test-only) so integration tests under interimBilling skip the shared beforeEach TRUNCATE of sign_up_form — without it the interim suite wiped the sign-up table under the sign-up suite and made it flaky (1 failure in 3 parallel runs; 0 in 6 after) — must be listed in DISPOSE.md (Task 13); if wrong, the sign-up suite flakes again.

- Task 4: Ruling: store.js also exports getRun, getRunByEnd, getInvoiceByStripeId, listInvoicesForRun, setStripeCustomerId (needed by later tasks), createInvoiceRow is idempotent per (run, carrier) and returns the existing row, rows use snake_case Prisma field names — later tasks use these names.

- Task 5: Ruling: the SQL function emits dates with to_char(... 'Z') and amounts as ::text, and parseLoadRows rejects any date without a zone designator — Kelevo's DateTime columns are timestamp without time zone (UTC), which JS would otherwise read as local time — if wrong, loads would shift by the server's UTC offset.

- Task 5: Ruling: ops artifacts carry placeholders (**IRON_WING_ORG_ID**, **KELEVO_DB_NAME**) filled only at apply time after the owner approves the exact text; the forced command runs through sudo as root with env_keep SSH_ORIGINAL_COMMAND; the 'psql' variables are passed with -f - on stdin because psql does not interpolate variables in -c.

- Task 7: Ruling: retrieveInvoice normalizes the pinned API's payments.data.payment.payment_intent into paymentIntent; payInvoice accepts an optional persisted attempt key, refetches first and refuses to pay an already processing intent. Added constructEvent, retrieveCharge and retrieveDispute for T11 — pinned SDK uses invoice payments instead of legacy invoice.payment_intent — if wrong, reconciliation fails closed for review.

- Task 9: Ruling: add listAssets, listAllLines, listMinimumLines, listRunsByStatus, updateInvoiceLines and withBillingLock store helpers. A PostgreSQL session advisory lock serializes mutations across instances while each ledger intent commits before Stripe calls; busy callers receive billing_busy, and a crashed connection releases ownership — same-status UPDATE cannot exclusively claim an already-building run — if wrong, contention delays this small module; no distributed lease is needed.

- Task 10: Ruling: persist transient paying status and an attempt number before payInvoice; recovery reuses that attempt's Stripe idempotency key and refetches its PaymentIntent. Add listPayingInvoices to recover retries on already-done runs — run-only recovery misses a crash during a later retry — if wrong, a retry awaits operator review rather than silently creating another payment.

- Task 11: Ruling: store.withTransaction scopes existing store helpers to a Prisma transaction; recordStripeEvent uses INSERT ON CONFLICT DO NOTHING so duplicates do not abort that transaction. Webhook failure effects persist the immediate backup schedule, with payment after commit by the worker — Stripe writes inside an event transaction could outlive a rollback — if wrong, a backup waits until the next worker tick after a crash.

- Task 12: Ruling: startup and each tick also resume approved runs (a crash can happen after approval but before charging starts); each tick retries interrupted builds/charges even with autoRun off — autoRun controls creating a new Friday run only — if wrong, a previously approved run resumes sooner than an operator expected, still within its approved totals.

- Final: Ruling: reviewer minor README relative-links finding is false — src/interimBilling/../../docs resolves to repository docs (verified existing file); ../../../docs would leave the repository — no change, cost if wrong is broken documentation navigation.

- Final: Ruling: real hosted Checkout, bank verification, Stripe late-return event shapes and actual email delivery remain an explicit sandbox verification gate — unit/integration tests and a real test-card invoice payment cannot establish them — if wrong, onboarding may fail; do not activate live collection on this evidence.

- Final: Ruling: live Stripe and production SSH installation remain excluded; full-suite verification is performed by the executor; dry-run mutation of detached Prisma rows is not a database write; holidays after 2027 require extending the documented calendar if still used; refunds/credits and self-service remain outside the module — these cover the reviewer's declined-to-judge list — if wrong, future operation needs additional work before live use.

- Final: Ruling: preapproval POST /runs explicitly rebuilds drafts; approval refuses ready unassigned lines until refreshed, while approved membership is immutable. Invoice membership and total are persisted atomically, then full remote currency/customer/metadata/amount and paginated per-line fees are checked again before each payment — an invoice may have changed outside this module — if wrong, mismatches stop collection for operator review rather than charging an unapproved amount.

- Final: Ruling: optional carrier effectiveFrom is a validated UTC calendar date and defaults to configured billing start for initial backlog onboarding; asset ownership applies only at/after that instant — the original interface had no way to onboard previous-week loads with the schema's now default — if wrong, choose an explicit date before creating the carrier; existing ledger ownership is preserved.

- Final: Ruling: summary_pending run state and failed_notifying invoice state plus listUnnotifiedFailures provide durable at-least-once mail recovery with existing tables; a crash after delivery may duplicate an email — no mail provider idempotency is available — if wrong, review duplicate notifications, never duplicate a payment.

## Follow-up: Checkout root cause and fix

The pinned Endive API removed Checkout create `payment_method_types`. The
adapter now uses `allowed_payment_method_types` as defined by the installed
Stripe SDK, retaining the card/US-bank allowlist. A removed-parameter regression
failed before the fix and passed after it. Primary and backup sessions were
then created and refetched in the guarded sandbox, offering both methods with
livemode false. This resolves session creation; it does not claim hosted
completion, ACH settlement, or actual email delivery.

## Follow-up: approved production reader

After the initial review, the owner approved the production reader artifacts,
real placeholders and dedicated key pair. The restricted role/function, OS
user, forced command, sudoers and source-restricted public key are installed.
A private key was generated on Hetzner and remained there; its trusted server
host key is pinned. Real source-host reads and command/forwarding/host-pin
rejection tests passed. Direct load-table read/write privileges are denied.
See [INSTALLATION.md](ops/kelevo-prod/INSTALLATION.md). This was an additive
reader installation, with no application deployment, live billing activation
or Kelevo restart. Earlier unapplied-status entries are historical.

At the production-reader follow-up, live catalog inspection was pending a live
credential. That read-only inspection is now complete; see
[LIVE-AUDIT.md](LIVE-AUDIT.md). The sandbox Dispatch product
is active with no default price and no catalog prices; the module instead
supplies per-load calculated fee amounts through inline price data. No live
product/account settings were changed.

A populated historical reader contract check validated 1 PAID load through the
actual parser, while the configured current billing window returned 0 rows.
No load rows were printed or persisted to workspace files. Checkout fix
verification: `npm test` 302/302; module lint passed; commit `ed6bee2`.

The absence of a fixed catalog price is intentional for this implementation:
5%, 10%, or fleet basis points are applied to each load's entered linehaul by
our money helpers, and the resulting cents are supplied on each invoice item.
For example $2,400 at 5% becomes a $120 item. Stripe supports inline
[`price_data`](https://docs.stripe.com/api/invoiceitems/create) for this purpose.
A fixed default price would not encode this per-load calculation. The subsequent
[LIVE-AUDIT.md](LIVE-AUDIT.md) confirms the correct live account, active Dispatch
product, linehaul description, empty fixed-price catalog, active card/ACH
capabilities and matching public support contacts. No live settings were changed.
