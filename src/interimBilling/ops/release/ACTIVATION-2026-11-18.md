<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Manual live activation — 2026-11-18

The owner explicitly approved enabling manual live billing and restarting the
backend, with automatic Friday run creation off. This approval did not include
creating carriers, sending setup emails, building live drafts or collecting a
payment. The owner had confirmed the required key write permissions and disabled
card/ACH retries in the Dashboard; see [Stripe readiness](STRIPE-READINESS.md).
Admin SSH-key replacement remains deferred as instructed.

## Applied and verified

Actions secret `INTERIM_BILLING_ENABLED` was set to `true`, then the known
successful [workflow 44111080462, attempt 2](https://github.com/Olorin4/iwd-backend/actions/runs/44111080462/attempts/2)
was rerun at application commit `1e538e9`. All 302 tests in 30 suites passed, and the build/deploy job passed.
This regenerated the runtime environment with the previously stored live webhook
signing secret. Its runtime value and the admin token were also compared
entirely in memory against their approved private records; both matched.
An agent/server interruption occurred during the run; its status
was checked on recovery, and no duplicate deployment was started.

The container restarted at `2026-11-18T03:09:33.074271157Z`, using image
`sha256:d9577ed19196df7a47564ba13fba02470267ab41c542d872ece849a72a7384fd`.
Hashes of 25 deployed application/module/package/schema/migration files matched
the verified source; later local documentation-only commits are not claimed to
be deployed application changes.

| Check                                  | Result                                             |
| -------------------------------------- | -------------------------------------------------- |
| Module enabled                         | `true`                                             |
| Stripe mode                            | `live`                                             |
| Automatic Friday run creation          | `false`                                            |
| Earliest eligible timestamp            | `2026-11-23T00:00:00Z`                             |
| Webhook signing secret                 | Loaded and config-validated; value not printed     |
| Billing admin token                    | Separate from the lead-listing admin token         |
| Public health                          | 200                                                |
| Missing billing admin token            | 401                                                |
| Authenticated GET of an absent run     | 404, `run_not_found`                               |
| Unsigned webhook POST                  | 400                                                |
| Empty sign-up/contact/newsletter POSTs | 403 at bot protection                              |
| Billing ledger                         | All six tables empty before and after verification |

The authenticated request used the token directly from the running process's
environment; it was never printed or placed into a command argument. The webhook
check sent unsigned empty JSON, so it could not record an event or trigger billing.
Public form rejection checks did not submit personal data or send emails.

The activated container's credential was verified by GET against live account
`acct_1UcfhXLodvRQZljj`. Endpoint `we_1Uco4NLodvRQZljjDMXtemfY` is live/enabled,
uses `2026-10-28.endive`, and retains the exact five approved event subscriptions
at `https://api.iron-wing-dispatching.com/interim-billing/webhook`. These reads do
not claim a real carrier's live setup or payment event was delivered; no live
carrier exists in this ledger yet.

## Operating boundary

The feature is ready for deliberate carrier onboarding. The scheduler now runs
recovery and retries for **already approved** work, but does not create Friday
runs automatically. There was no existing work to resume: all six tables were
empty. No carrier, invoice, payment method, event row or charge was created by
activation, and no setup/statement email was sent.

Onboarding requires the actual carrier agreement, fee, asset mapping, effective
date and authorization to contact that carrier. Inspect a dry run before building
any live drafts. Every run still requires its exact invoice count and total to
be approved before initial collection; the approved retry policy then applies.
The existing [rollout procedure](PRODUCTION-ROLLOUT.md) describes rollback and
collection ownership. Setting the module off also stops event handling and
recovery, so reconcile any future pending ACH payments before a later shutdown.
