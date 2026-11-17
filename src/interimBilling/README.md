<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Interim weekly billing

Temporary billing for Iron Wing's first carriers. Delete this module when
KelevoTMS dispatching-agency billing replaces it: [DISPOSE.md](DISPOSE.md).
The module defaults off. This branch is sandbox-only and is not deployed.

Binding [design](../../docs/superpowers/specs/2026-11-17-interim-weekly-billing-design.md)
and [plan](../../docs/superpowers/plans/2026-11-17-interim-weekly-billing.md).
Use the [sandbox walkthrough](SANDBOX-TEST.md) before considering live approval.

## Configuration

Enable explicitly with `INTERIM_BILLING_ENABLED=true`,
`INTERIM_BILLING_MODE=sandbox`, a test-prefixed `STRIPE_SANDBOX_SECRET_KEY`,
and an independent `INTERIM_BILLING_ADMIN_TOKEN` of at least 32 characters.
Configure `INTERIM_BILLING_START_DATE` (UTC lower bound, YYYY-MM-DD),
`INTERIM_BILLING_STRIPE_WEBHOOK_SECRET`, `INTERIM_BILLING_PRODUCT_ID`,
`INTERIM_BILLING_ADMIN_EMAIL`, and the four `INTERIM_BILLING_KELEVO_SSH_*`
settings listed in [disposal](DISPOSE.md). Sandbox file fixtures still require
placeholder SSH settings, but no SSH runs when `INTERIM_BILLING_LOADS_FILE` is set.

The default zone is America/Chicago and the Friday run hour is 06:00.
`INTERIM_BILLING_AUTO_RUN` defaults false. Enabling it creates a draft run on
Friday; **every run still needs human approval**. Retries and recovery of
already-approved work run while the module is enabled, independently of autorun.

Set all new CI secrets before any future approved deploy: the existing workflow
rebuilds `.env`. Production SSH artifacts under [ops](ops/kelevo-prod/README.md)
were subsequently approved, installed and verified; see the
[installation record](ops/kelevo-prod/INSTALLATION.md).
The application branch is still local and disabled. No push, merge, application
deployment or live charge was performed.

## API and operation

All routes start `/interim-billing`. Use the dedicated bearer token for every
route except `POST /webhook` (Stripe signature). Card and bank details go only
to Stripe Checkout. Store only Stripe ids, brand and last four.

| Method and path                 | Body or behavior                                                          |
| ------------------------------- | ------------------------------------------------------------------------- |
| POST `/carriers`                | `legalName, mc, usdot, email, feeBp, driverIds, truckIds, effectiveFrom?` |
| POST `/carriers/:id/setup-link` | `role: primary` or `backup`; emails hosted setup URL                      |
| POST `/runs?dryRun=true`        | Read-only preview; no ledger, Stripe or mail writes                       |
| POST `/runs`                    | Build draft invoices for unledgered loads before latest Monday            |
| GET `/runs/:id`                 | Inspect stored run, lines and invoices                                    |
| POST `/lines/:id/linehaul`      | `amount` decimal string and required `note`                               |
| POST `/lines/:id/decide`        | Boolean `charge`; carrier-cancelled loads only                            |
| POST `/runs/:id/approve`        | `invoiceCount, totalCents`; exact expected totals; starts charging        |

Linehaul is the only fee basis. Entered settlement linehaul is a prefill;
otherwise the load is held. Cancelled loads always need a human decision.
Non-USD, missing carrier and conflicting mappings stay held. Do not work around
such holds by changing fees; resolve source/mapping issues with operator review.
The initial API maps assets once; historical ledger ownership never changes.
Optional `effectiveFrom` (YYYY-MM-DD, UTC) applies to those assets; it defaults
to the configured billing start date for initial backlog onboarding. Loads
before ownership began are held instead of assigned to that carrier.

Before approval, resolve held lines and POST `/runs` again to refresh the
current drafts and summary. Approval refuses pending ready lines until that
refresh. Runs are immutable after approval; lines resolved afterwards enter
the next weekly run. Subminimum carrier totals
carry forward until at least 50 cents is due. Held lines are never paid.

One PostgreSQL session advisory lock serializes mutation across instances.
`billing_busy` (409) means retry later. Stripe intent and attempt ids are durable;
startup and worker ticks reconcile interrupted builds, summaries, approvals and charges.
Summary/final failure emails have durable pending states and retry after a
send failure or crash; duplicate notifications are possible after uncertain delivery.
ACH `processing` remains pending without retries. Declines try backup, then
primary/backup at +1 and +3 US business days; pausing bookings stays manual.
Late returns and disputes alert the admin without further automatic collection.
Federal holiday dates currently cover 2026 and 2027; extend before 2028 if the
module has not yet been disposed of.

Stripe receipts can accompany module statement emails. Correct statements,
refunds and credits in Stripe Dashboard; questions are due within 14 days.

## Verification

Use Node 22.20.0, `npm ci`, `npx prisma generate`, `npm test`,
`npm run test:integration`, and `npx eslint src/interimBilling`.
Integration tests require the guarded `*_test` database; never point them at
production. Do not print keys, raw Stripe/SSH errors or personal information.
