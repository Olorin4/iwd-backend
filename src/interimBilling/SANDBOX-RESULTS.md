<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Sandbox verification — 2026-11-17

Verification label: `mwkr5peg`. The account was checked as
`acct_1UcfhnLbp6WU1kVS` before requests, using a test-prefixed key.
The local API, real Stripe SDK, Stripe CLI event forwarding, SMTP and an isolated
`iwd_billing_sbx_mwkr5peg_test` database were used. Carrier/load records were
synthetic; emails went only to the public business inbox. No live Stripe writes,
application deployment, push or merge occurred.

## Hosted setup and statements

- Chromium completed hosted Checkout card setup. A verified, refetched
  `setup_intent.succeeded` event saved the primary method.
- Hosted backup bank entry and microdeposit descriptor verification completed.
  The backup stayed unset until verification succeeded. SetupIntent:
  `seti_1UcmyULbp6WU1kVSc2uGwMFw`.
- The owner confirmed receipt of the setup email, admin summaries, the
  statement containing the Stripe payment link and invoice PDF link, and
  the separate “Dispatch payment unsuccessful” email.
- An invalid webhook signature returned 400 without recording an event.
  Signed redelivery of the same real setup event twice left one event row and
  did not change the carrier again.

## Approval and crash recovery

Invoice `in_1UcnCcLbp6WU1kVSnoyyuTw6`: paid **24000 cents**, three line items.
The dry run wrote no ledger/email records; missing linehaul and cancellations
were held. Human decisions included the carrier cancellation and skipped the
broker cancellation. Undated cancellation remained held. An old 12000-cent
approval returned 409 after the draft refresh.

Actual worker processes were terminated after real Stripe draft creation,
finalization and payment calls, before the corresponding local completion.
Restart reconciliation recovered the existing remote objects. Finalization
left the invoice open with `auto_advance: false` until approved collection.
Repeating runs, approval, recovery and due retries did not add items or charges.

## Declines and ACH

| Scenario                         | Actual sandbox evidence                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary and backup decline       | `in_1UcnOKLbp6WU1kVSGghVcT5x`: six charges across three rounds, then terminal failed.                                                                |
| Thanksgiving retry dates         | First failure Nov 25; retries Nov 27 and Dec 1. A tick immediately before each due time made no attempt.                                             |
| No backup                        | `in_1UcnUSLbp6WU1kVScXodmuYu`: three charges, then terminal failed.                                                                                  |
| Payment crash and working backup | `in_1UcnUpLbp6WU1kVSLgw7djo7`: restart reused the declined primary attempt and paid with backup; two charges total.                                  |
| Bank processing                  | `in_1UcnVXLbp6WU1kVS05asETtN`: one attempt, no next retry, still processing after repeated ticks and restart.                                        |
| Bank success                     | `in_1UcnVoLbp6WU1kVShT15ilxF`: actual paid event, one attempt.                                                                                       |
| Bank failure and backup          | `in_1UcnWJLbp6WU1kVSCQfsTm2i`: actual failure event; backup paid, two attempts.                                                                      |
| Post-payment bank dispute        | `in_1UcnWrLbp6WU1kVSQPuZpm1B`: real dispute event, admin alert, one payment attempt and no retry. Duplicate signed redelivery sent no further alert. |

Additional payment outcomes used Stripe's published sandbox PaymentMethod tokens
and real SetupIntents/events; they did not repeat hosted UI entry for every
fixture. Future dates were injected into worker dependencies to exercise retry
policy; no public clock-override endpoint was added. Charge objects were counted
per synthetic customer: Stripe invoice `attempt_count` is not a reliable count
of these manual payment calls.

## Fix and verification

Regression tests first reproduced misleading failure codes on paid/processing
outcomes. The adapter and webhook now clear the error code for those outcomes.
The fix was also checked against the real processing and paid sandbox invoices.
Earlier terminal fixture rows retain their pre-fix diagnostic label; no historical
ledger rewrite was performed. The focused tests pass, and `npm test` passes **302 tests in 30 suites**, including
integration tests. ESLint and whitespace checks pass. Jest also reported a
worker teardown warning; the test command exited successfully.

## Delivery and limits

All 23 emails tracked by the resumed harness were accepted by SMTP, with zero
rejections. Inbox receipt was separately confirmed by the owner as above.
Real sandbox paid, failed, setup and dispute events reached the HTTP handler.
Explicit signed redelivery exercised duplicate setup/dispute events; these used
actual refetched Stripe events. The CLI can receive 503 while the module lock is
busy or the worker is intentionally stopped; production webhook delivery must
retain Stripe retry behavior.

A failed ACH debit and a post-payment dispute were generated by Stripe. The
separate `invoice.payment_failed`-after-paid branch remains regression-tested
with fixtures; this run did not manufacture a real late-return invoice event.
Sandbox bank outcomes simulate settlement and do not prove live bank settlement.
The live release still needs its separate configuration, webhook, CI-secret and
approval checks; successful sandbox testing does not activate the application.

The local API/worker and Stripe listener were stopped after verification. Stripe
rejected both direct cancellation of the pending fixture's PaymentIntent and
voiding its invoice (`StripeInvalidRequestError`); the synthetic processing
fixture remains as sandbox evidence. Its local ledger is retained in the isolated
test database and must not be resumed for production use. No live funds exist
in this fixture.
