<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Sandbox walkthrough

Use the separate Stripe sandbox account, a test-prefixed key, synthetic
carrier data and an email inbox you control. The Stripe plugin is connected
to LIVE; do not use it for this procedure. No Kelevo production access is
needed. Keep the module off on deployed systems during this local test.

## Local setup

Use Node 22.20.0, install dependencies and generate Prisma. Load credentials
through the existing runtime environment; never paste keys into commands,
logs or this document. Use only the guarded `*_test` database. Run migrations
against that database, never against production. Use a disposable test database
or fresh load ids/run weeks to avoid previous ledger entries affecting results.

Use settings from [README.md](README.md), `INTERIM_BILLING_AUTO_RUN=false`,
`INTERIM_BILLING_START_DATE=2026-11-01`, and
`INTERIM_BILLING_LOADS_FILE=/tmp/interim-billing-loads.json`.
Set SSH fields to inert sandbox placeholders; the file source bypasses SSH.

Save this JSON fixture (dates precede the Monday 2026-11-16 run end):

```json
[
    {
        "id": 91001,
        "load_number": 101,
        "status": "DELIVERED",
        "driver_id": 7,
        "truck_id": 8,
        "rate": "2800.00",
        "currency": "USD",
        "entered_linehaul": "2400.00",
        "delivered_at": "2026-11-12T18:00:00Z",
        "delivery_end": null,
        "canceled_at": null
    },
    {
        "id": 91002,
        "load_number": 102,
        "status": "PAID",
        "driver_id": 7,
        "truck_id": 8,
        "rate": "1900.00",
        "currency": "USD",
        "entered_linehaul": null,
        "delivered_at": null,
        "delivery_end": "2026-11-13T18:00:00Z",
        "canceled_at": null
    },
    {
        "id": 91003,
        "load_number": 103,
        "status": "CANCELED",
        "driver_id": 7,
        "truck_id": 8,
        "rate": "1000.00",
        "currency": "USD",
        "entered_linehaul": "800.00",
        "delivered_at": null,
        "delivery_end": null,
        "canceled_at": "2026-11-13T18:00:00Z"
    },
    {
        "id": 91004,
        "load_number": 104,
        "status": "CANCELED",
        "driver_id": 7,
        "truck_id": 8,
        "rate": "1000.00",
        "currency": "USD",
        "entered_linehaul": null,
        "delivered_at": null,
        "delivery_end": null,
        "canceled_at": null
    }
]
```

Register a sandbox webhook or forward Stripe CLI sandbox events to
`http://localhost:3000/interim-billing/webhook`. Load its matching signing
secret through the environment. Subscribe to `setup_intent.succeeded`,
`invoice.paid`, `invoice.payment_failed`, `invoice.finalized`,
`charge.dispute.created`. Verify the CLI is authenticated to the sandbox,
not the live account, before forwarding. Start the local API.

The examples below are request bodies for an HTTP client with the dedicated
bearer token stored privately. Never put a real token into the examples.

## Happy path

1. POST `/interim-billing/carriers`:

    ```json
    {
        "legalName": "Sandbox Test Carrier",
        "mc": "123456",
        "usdot": "1234567",
        "email": "YOUR_CONTROLLED_TEST_INBOX",
        "feeBp": 500,
        "driverIds": [7],
        "truckIds": [8],
        "effectiveFrom": "2026-11-01"
    }
    ```

    Expect 201 and a carrier id. Use that id below. Names and emails never appear
    in invoice item descriptions.

2. POST `/carriers/:id/setup-link` with `{"role":"primary"}`. Expect a hosted
   Checkout URL and a setup email. No payment occurs. Complete **on Stripe's
   hosted page** with `4242 4242 4242 4242`, any future expiry and any test CVC.
   The completion redirect indicates setup submitted; the saved method appears
   only after `setup_intent.succeeded` has been verified and refetched.
3. Repeat with `{"role":"backup"}` and select US bank account. Use Stripe's
   sandbox bank picker/test institution (or its published test routing/account
   details on the hosted page only). Finish verification, including sandbox
   micro-deposits if requested. Expect no saved backup while verification is
   incomplete, and a stored `pm_...` plus last four after success.
4. POST `/runs?dryRun=true`. Expect one invoice, 12000 cents, load 102 held
   `needs_linehaul`, load 103 held `cancelled_by_whom`, and one undated
   cancellation. Check that no run/line row, Stripe draft or email was created.
5. POST `/runs`. Expect the same amounts with a run id, a Stripe draft whose
   `auto_advance` is false, attached line item 101, a summary email, and status
   `awaiting_approval`. GET `/runs/:id` for local line and invoice ids.
6. POST `/lines/<load-102-line-id>/linehaul` with
   `{"amount":"1600.00","note":"Confirmed linehaul excluding fuel"}`.
   Expect `ready`, fee 8000 cents. POST `/lines/<load-103-line-id>/decide`
   with `{"charge":true}`. Expect ready, fee 4000 cents. For a broker or
   shipper cancellation use false instead and expect `skipped`.
   POST `/runs` again before approval: expect the refreshed current draft to
   include both resolved loads, total 24000 cents. A stale 12000-cent approval
   is refused.
7. POST `/runs/:id/approve` with `{"invoiceCount":1,"totalCents":24000}`.
   Expect approved charging, statement email with hosted invoice and PDF,
   paid invoice and paid lines. A stale total gets 409 and no charge.
8. Repeat POST `/runs` and the approval. Expect the existing approved run and 409 on
   reapproval, with no additional item or payment. Replay the same webhook:
   expect 200 and no repeated state effect.
9. At the next Monday cutoff, create the next run. Expect no invoice for these already-billed loads. Lines resolved only
   after approval are picked up once by this next run. For an
   accelerated test, invoke `startRun({now: new Date("2026-11-27T15:00:00Z")},
deps)` in a **test-only harness** with the same sandbox dependencies.
   No API clock override is exposed.

All unprefixed paths above are relative to `/interim-billing`.

## Decline, backup and ACH pending

In a fresh sandbox carrier/run, save failing card `4000 0000 0000 0341`
on the hosted primary setup page and a successful test card as backup.
Approve a run: primary fails, backup is attempted immediately, then the invoice
is paid. Setup failure itself must never save an unusable primary.

With two failing methods, expect primary/backup in round 0, then the same at
+1 and +3 US business days after the first failure. For a first failure on
2026-11-25, due dates are 2026-11-27 and 2026-12-01 (Thanksgiving/weekend skipped).
Use dependency-injected `now` in the isolated test harness to advance time;
calling due retries before the timestamp must do nothing. After round 2 fails,
expect `failed`, no further retry, and admin/carrier emails. Booking pauses
remain a human decision.

Save a verified sandbox bank account as primary and approve another run.
While Stripe reports PaymentIntent `processing`, expect no backup attempt or
scheduled retry despite repeated worker ticks and webhook delivery. A later
success marks paid; a real failure schedules the backup after event commit.
A late return after paid or a dispute only alerts the admin; inspect manually.

## Evidence and limits

Automated tests exercise signature verification, transactional deduplication,
DST, retries, processing protection and crash recovery using fakes plus the
local test database. A sandbox API smoke test is separate from hosted Checkout,
ACH verification and real email delivery. Record those results separately;
HTTP 200 and a created session do not prove the whole flow.

Recorded 2026-11-17: a guarded sandbox API probe completed invoice creation,
attached item, metadata reconciliation, finalization and a successful test-token
card payment (`in_1UclH5Lbp6WU1kVScbXVBnGg`). It did not send module email.
Combined card/ACH Checkout and a minimal card-only Checkout both returned
`StripeInvalidRequestError` for `payment_method_types`, despite the sandbox
reporting active capabilities and available/on payment methods. No account
configuration was changed. Inspect the sandbox Developers request logs for
`POST /v1/checkout/sessions` before continuing hosted setup and ACH verification.
Those flows, real email delivery and bank settlement are **not verified**.

Follow-up verification on 2026-11-17: the rejection was traced to the removed
Checkout create parameter `payment_method_types` in pinned Endive. The adapter
now sends `allowed_payment_method_types: ["card", "us_bank_account"]`. Real
sandbox primary and backup sessions were created and refetched successfully;
both offer card and US bank account, are setup mode, and have livemode false.
Hosted completion, bank verification/settlement and actual email delivery still
require the walkthrough above. No fixed catalog Price is used: each invoice
item supplies its calculated fee through inline `price_data.unit_amount`.
