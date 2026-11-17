# Interim weekly billing for Iron Wing carriers (disposable)

> **THIS FEATURE IS TEMPORARY AND MUST BE DELETED when the dispatching-agency
> billing feature in KelevoTMS goes live.** It exists only to bill Iron Wing's
> first carriers while that feature is built. It is designed so that deleting
> it is a short, listed procedure (see "Isolation and disposal").

Status: revised after an independent review, 2026-11-17; awaiting the owner's
approval. Written by Claude. The owner has decided: weekly Friday charge by
card, bank debit (ACH) or both; Stripe, Iron Wing sandbox first; production
KelevoTMS read through a restricted SSH command; the dispatcher types the
linehaul amount for each load.

## Intent

Iron Wing charges each carrier a fee on loads it books. The agreement draft
(business folder, `04 Templates`), the website, Jack and the carrier documents
say the same thing:

- Fee: 5% (Essential), 10% (Full-Service) or an agreed fleet percentage, of
  the **linehaul rate** of each load. Never on fuel surcharge, detention,
  layover, TONU, extra stops, driver assist or reimbursements such as lumper.
- Paid by card, bank debit (ACH), or both (one primary, one backup).
- **Every Friday** the carrier is charged for loads **delivered** since the last
  run and for loads the **carrier cancelled** after accepting them. Loads the
  broker or shipper cancelled are not charged.
- An emailed statement lists each load and its fee. The fee is owed whether or
  not the carrier factors and whether or not the broker pays.
- A declined charge or returned debit is retried within 3 business days, using
  the backup method if there is one; after that new bookings may be paused.
- A carrier has 14 days to question a statement; errors are refunded or
  credited.

By hand this is 10 to 15 minutes per carrier each Friday in the Stripe
Dashboard. This feature does the repetitive part (fetching loads, working out
fees, building invoices, charging, retrying) and leaves the judgement calls to
a person.

## Goals, non-goals, anti-goals

Goals
- Correct, repeatable weekly billing for a handful of carriers.
- Card and bank details never touch our servers; Stripe holds them and the ACH
  authorisation.
- A load is never billed twice, even across re-runs, crashes and redeploys.
- A person approves every run before money moves.
- Delete-able in an afternoon.

Non-goals (all of this belongs to the KelevoTMS feature)
- Carrier-facing screens or logins; a dispatcher UI; multi-agency support.
- Stripe Connect, tax, subscriptions, payouts, e-signatures.
- Any change to KelevoTMS code or its schema.

Anti-goals (a failure even if it technically works)
- Charging a carrier for something it does not owe: a broker-cancelled load, a
  fee on fuel, a load billed twice, a load that is not Iron Wing's.
- Card or bank numbers, or personal data, in our database, logs or error text.
- Hooks spread through the rest of iwd-backend so it cannot be removed.

## Approaches considered

1. **Manual in the Stripe Dashboard.** No code. Rejected by the owner:
   automate now.
2. **Automate inside iwd-backend (chosen).** Isolated module, own tables, a
   few marked hooks. Thrown away when KelevoTMS has the feature.
3. **Build billing inside KelevoTMS now.** The right long-term home and the
   owner's preference; too large to wait for.

How the module reads production KelevoTMS (owner chose B1):
- **B1 Restricted SSH read (chosen):** a key that can run one fixed script on
  `kelevo-prod`, which calls one read-only function. No KelevoTMS code change,
  no restart, nothing exposed.
- B2 Postgres published on the Tailscale address: needs a production database
  restart and exposes the database to the tailnet.
- B3 A new KelevoTMS endpoint: a KelevoTMS release for throw-away code.
- B4 Manual CSV upload: not automatic.

## Facts about KelevoTMS that shape the design (verified in its code)

- Loads are in table `load`; related tables are `driver`, `truck`,
  `organization`, `settlement_load_input`. Status values used here: `DELIVERED`,
  `PAID` (delivered and invoiced), `CANCELED`.
- **`linehaul_rate`, `fuel_surcharge`, `accessorial_total` and similar columns
  are NULL for every real organization:** nothing writes them (comment in
  `loads.query.ts`). The only reliable amount is `rate`, the agreed all-in
  total, which includes fuel. So the module never trusts `linehaul_rate`.
- A person-entered linehaul exists only as `settlement_load_input.linehaul_amount`
  (driver-pay flow, some loads only); it is used as a prefill when present.
- A load records its organization, driver and truck, not the carrier it was
  booked for, and not who cancelled it.
- `delivered_at` is null on older loads (`delivery_end` is the fallback);
  `canceled_at` is stamped conditionally and some `CANCELED` loads have none.
- Timestamps are UTC; the load has no time zone. `driver_id` is the current
  driver, not necessarily the one at delivery.
- KelevoTMS has no database views and migrates often, including column type
  changes. A view over `load` would make Postgres refuse those migrations, so
  the module uses a **function**, which Postgres does not tie to columns.

## How it works

### Reading loads (restricted SSH)

- On `kelevo-prod`, once, additively and without a restart: a database login
  `iwd_billing_ro` that can only `EXECUTE` one `plpgsql` function,
  `iwd_billing_loads(from_ts, to_ts)`, created `SECURITY DEFINER` with a fixed
  `search_path`. The function returns, for Iron Wing's organization only and
  excluding deleted loads: `id, load_number, status, driver_id, truck_id, rate,
  currency, entered_linehaul` (from `settlement_load_input`), `delivered_at,
  delivery_end, canceled_at`. If a KelevoTMS migration later renames a column
  the function errors at call time and billing fails closed; it never blocks a
  KelevoTMS deploy.
- A dedicated key pair. The private key is a file on the Hetzner host, mounted
  read-only into the container, never in the repository, the image or `.env`.
  The host key of `kelevo-prod` is pinned in a known-hosts file mounted the same
  way, and the connection fails if it does not match. The container reaches
  `kelevo-prod` by its Tailscale IP, because the container cannot resolve
  Tailscale names.
- On `kelevo-prod` the public key sits in `authorized_keys` with
  `command="<script>"`, `restrict` and `from=<the Hetzner server's tailnet
  address>` (checked at build time that this is the address `sshd` sees).
- The script runs as a **dedicated unprivileged user**. That user is not in the
  `docker` group; a `sudoers` rule lets it run exactly this one script. The
  script reads the window from the forced command's original argument, accepts
  only two UTC timestamps in a fixed format, and calls the function; it prints
  JSON.
- The module runs `ssh` without a shell (`execFile`) with a timeout, then
  validates the JSON (types, required fields, sizes) before using any of it.
- The three production changes (login and function, script and sudoers rule,
  authorised key) are made only after the owner approves the exact SQL and
  script text.

### This module's tables

All prefixed `interim_billing_`, in their own marked block of `schema.prisma`
(the file is the repository's single schema) and their own migration:

- `carrier`: legal name, MC, USDOT, billing email, plan label, **fee in basis
  points** (500 = 5%, 1000 = 10%, any other value for a fleet), Stripe customer
  id, primary and backup payment-method ids with brand and last four, status.
- `carrier_asset`: a KelevoTMS `driver_id` or `truck_id` owned by a carrier,
  with the date it started applying.
- `run`: one per run (unique on the run's week end), status (`building`,
  `awaiting_approval`, `approved`, `charging`, `done`), approver and time,
  approved invoice count and total.
- `line`: one per (KelevoTMS load id, kind), kind `DELIVERED` or
  `CARRIER_CANCELLED`, **unique on that pair**; carrier, all-in rate and
  linehaul cents, fee basis points, fee in cents, hold reason, Stripe
  invoice-item id, status (`held`, `ready`, `invoiced`, `paid`, `failed`,
  `skipped`).
- `invoice`: one per carrier per run: Stripe invoice id, total cents, status,
  attempts, next attempt time, current payment method, PaymentIntent id, last
  error code. This carries the retry schedule.
- `stripe_event`: event ids already handled.

Money is integer cents and basis points throughout; Decimal strings are parsed
to cents, never floats. Fee = linehaul cents x basis points / 10,000, rounded
half-up. The module only bills `USD`; any other currency is held.

### Setting up a carrier

Admin API (all under `/interim-billing`, protected by its own bearer token
`INTERIM_BILLING_ADMIN_TOKEN`, separate from the one that lists leads):

1. `POST /carriers`: legal name, MC, USDOT, email, fee in basis points, and the
   KelevoTMS driver and truck ids that belong to the carrier.
2. `POST /carriers/:id/setup-link` with `role: primary | backup`: creates the
   Stripe customer if needed and a **Checkout Session in setup mode** (card and
   US bank account) showing the agreement's authorisation wording, and emails
   the link. Nothing is charged. Stripe verifies a bank account (instant bank
   login, or two micro-deposits) and records the ACH authorisation.
3. The method is stored for that carrier only when Stripe says it is usable:
   on `setup_intent.succeeded`, after refetching the SetupIntent and
   PaymentMethod from Stripe. A bank account awaiting micro-deposits is not
   stored yet.

A carrier cannot be billed without a primary method.

### A run

A run is started by `POST /runs` (admin), or by the scheduler if
`INTERIM_BILLING_AUTO_RUN=true` (off by default; it checks every 15 minutes and
starts a run on Friday after 06:00 `INTERIM_BILLING_TIMEZONE`, default
`America/Chicago`, if none exists for that week). `POST /runs?dryRun=true`
shows what a run would do without touching Stripe or the ledger. A run claims
itself with an atomic `UPDATE ... WHERE status = ...`, so two runs cannot
overlap.

1. **Scope.** The run's end is the most recent Monday 00:00 in the configured
   zone (converted to UTC, correct across daylight saving changes). It bills
   every `DELIVERED`/`PAID` load delivered before that end and on or after
   `INTERIM_BILLING_START_DATE` that has no `line` yet, so a load entered
   late or a run that was missed is picked up next time. Delivery time is
   `delivered_at`, else `delivery_end`. Cancelled loads: `status = CANCELED`
   and `canceled_at` before the end and on or after the start date; the summary
   also reports how many `CANCELED` loads have no `canceled_at` (never billed
   automatically).
2. **Classify each load** (already-ledgered loads are skipped):
   - no carrier, or driver and truck map to different carriers: `held`;
   - non-USD: `held`;
   - **no linehaul yet: `held` "needs linehaul"**; the summary lists the load
     with its all-in rate for reference, prefilled with `entered_linehaul` if
     present. The admin sets it with `POST /lines/:id/linehaul` (amount and a
     short note, recorded);
   - **cancelled: always `held` "cancelled, by whom?"**; the admin decides with
     `POST /lines/:id/decide` (`charge: true` if the carrier cancelled, `false`
     otherwise; a charged cancellation also needs a linehaul figure);
   - fee below Stripe's minimum charge (50 cents): held and carried to the next
     run;
   - otherwise `ready` with the fee worked out.
3. **Build Stripe drafts.** For each carrier with `ready` lines: persist the
   intent in the database first, then create the invoice
   (`collection_method: charge_automatically`, **`auto_advance: false`** so
   Stripe never finalises, charges or retries it on its own; statement
   descriptor `IRON WING DISPATCH`; footer with the support email and phone;
   metadata with the run id), then one invoice item per line attached with
   `invoice: <id>`, described like `Load 1234, delivered Wed Nov 18: linehaul
   $2,400.00 x 5% = $120.00`, using the "Dispatch fee" product. The Stripe
   `apiVersion` is pinned. Idempotency keys protect one attempt only (they
   expire after about a day), so a rerun reconciles by listing the carrier's
   invoices by metadata rather than trusting them.
4. **Summary email** to `INTERIM_BILLING_ADMIN_EMAIL`: invoices and totals, and
   every held line with its reason.
5. **Approval.** `POST /runs/:id/approve` must carry the expected invoice count
   and total; a stale or changed run is refused. Nothing is charged before
   this. Lines resolved after approval go on the next run.
6. **Charge.** Each approved invoice, one at a time with an atomic claim:
   finalise it, email the carrier the statement (the hosted invoice page and PDF
   links), then pay it with the primary method (`invoices.pay` with the
   payment method). A run left `charging` by a crash or redeploy is resumed
   from its database state on startup.

### Payment outcomes and the 3-business-day rule

Stripe's retries are off; this module applies the agreement's rule.

- **A bank debit that is `processing` is pending, not failed.** It stays
  pending until Stripe reports the result. The module never starts a second
  attempt while a PaymentIntent is `processing`; this prevents charging both
  methods.
- On `invoice.payment_failed` (or an immediate card decline): pay with the
  backup method straight away if there is one; still unpaid: retry (primary,
  then backup) 1 and 3 business days later. US federal holidays are excluded.
- After the last attempt: mark the invoice `failed`, email the admin and the
  carrier. Pausing new bookings is the admin's decision.
- Late bank returns and disputes (`charge.dispute.created`, returns after an
  apparent success) do not retry; they alert the admin.
- Stripe's own receipt emails remain on; they may arrive alongside this
  module's statement email.

### Statements, questions and corrections

The itemised Stripe invoice, linked from our email, is the statement.
Corrections within 14 days (refund or credit note) are made in the Stripe
Dashboard; this module has no refund or credit screens.

### Webhook

`POST /interim-billing/webhook` verifies the Stripe signature using the raw
request body, which is captured by a `verify` callback added to the existing
`express.json()` line (so the route keeps logging, helmet, CORS and error
handling). It stores each event id in the same transaction as its effect,
ignores repeats, refetches the object from Stripe rather than trusting the
event body, and handles `setup_intent.succeeded`, `invoice.paid`,
`invoice.payment_failed`, `invoice.finalized` and `charge.dispute.created`. A
webhook secret is per endpoint and per mode.

## Isolation and disposal

- All code is in `src/interimBilling/`. Every file starts with the banner
  `TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is
  live. See DISPOSE.md.` The folder also holds `README.md` and `DISPOSE.md`.
- Tables: only `interim_billing_*`.
- Settings: only `INTERIM_BILLING_*` plus the Stripe keys.
- Hooks in the rest of the app, each carrying the banner and listed in
  `DISPOSE.md`:
  1. one line in `router.js` mounting `/interim-billing`;
  2. the `verify` callback on `express.json()` in `app.js`, and one line
     starting the scheduler there;
  3. the `stripe` package in `package.json`, the marked model block in
     `schema.prisma`;
  4. `openssh-client` in the `Dockerfile` and a read-only volume for the key
     and known-hosts file in `docker-compose.yml`;
  5. the `INTERIM_BILLING_*` secrets in the CI workflow that writes `.env`
     (otherwise a CI deploy would erase them from the server).
- **Disposal:** delete `src/interimBilling/` and its tests; remove the five
  hooks; export then drop the `interim_billing_*` tables in a migration; remove
  the settings; delete the Stripe webhook endpoint (and the "Dispatch fee"
  product if unused); on `kelevo-prod` remove the authorised key, script,
  sudoers rule, function and database login; delete the key files on the
  Hetzner host.

## Safety rules

- **Mode.** `INTERIM_BILLING_MODE` is `sandbox` or `live`. Sandbox uses the
  sandbox keys and refuses a key not starting `sk_test_` or `rk_test_`; live
  needs `INTERIM_BILLING_LIVE_CONFIRM=yes` and a restricted live key
  (`rk_live_`). The mode is logged at start. The module is off unless
  `INTERIM_BILLING_ENABLED=true`.
- **Money moves only after approval,** only for that run's invoices.
- **Logs:** ids, counts and status codes only; never names, emails, amounts per
  carrier, payment details, keys, or raw Stripe or SSH error text (map errors
  to codes). Emails to the admin and carriers do carry amounts; that is their
  purpose.
- **Idempotency:** unique keys on runs and lines, the ledger written before
  each Stripe call, event ids stored, startup reconciliation of invoices left
  `draft` or `open`.
- **Process safety:** deploys redeploy the container and `shutdown.js` exits
  after flushing PostHog; every run step is therefore resumable from the
  database and none holds state in memory.
- Admin routes use `INTERIM_BILLING_ADMIN_TOKEN`; it has no identity, so the
  recorded approver is "admin token". Acceptable while one person approves.

## Testing

Unit tests with Stripe and the SSH call mocked, plus a hand-run end-to-end test
in the Stripe sandbox (test cards and the sandbox bank account). Must cover:
fee rounding in cents and basis points; the run end across daylight saving
changes; null `delivered_at`; late-entered loads picked up; linehaul held,
entered and prefilled; cancelled loads held until decided; no load billed twice
across reruns and crashes; carrier by driver, by truck, and conflicts; webhook
signature, duplicates and out-of-order events; a `processing` bank debit never
triggering a second attempt; the failure schedule with and without a backup;
the mode and key-prefix guards; rejection of malformed SSH output; the dry run
touching nothing; stale approval refused.

## Left to the builder (my calls, change any of them)

- The run end is cut in `America/Chicago` (one setting); Stripe's Dashboard is
  set to US/Eastern, so Eastern is a one-line change.
- Approval is an authenticated API call, not a screen.
- Re-mapping a driver or truck applies only to loads not yet in the ledger.
- Failed bank-debit fees and disputes are absorbed by Iron Wing (the draft
  agreement does not pass them on); flagged for the lawyer.
- No cap on a run's total beyond the approval's stated count and total.
- Exact SQL for the function and login, the script and sudoers rule, and the
  invoice text are shown to the owner before anything is changed on production.

## Changes made after the independent review

The review found that KelevoTMS stores no linehaul for real organizations; the
design now holds every load for a typed linehaul (owner's decision). Also fixed:
a view replaced by a function, the webhook raw-body hook, bank debits that are
processing, micro-deposit verification, invoice-level retry state, atomic
claims, selection by start date rather than week, basis points, a dry run, the
scheduler off by default, a separate approval token, and the missing hooks.
