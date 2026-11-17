# Interim Weekly Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the temporary, isolated module in iwd-backend that bills Iron Wing carriers weekly through Stripe (sandbox only in this plan).

**Architecture:** One folder, `src/interimBilling/`, with pure units (money, schedule, classify, retry policy), thin adapters (SSH reader, Stripe client, store) and a small Express router. A run reads KelevoTMS loads, writes a ledger, builds Stripe draft invoices, waits for approval, then charges and retries by its own rules. Five marked hooks connect it to the app and all of it is deleted later by `DISPOSE.md`.

**Tech Stack:** Node 22, ESM, Express 4, Prisma 7 (`@prisma/adapter-pg`), Jest with babel, nodemailer (existing `src/emailService.js`), new dependency `stripe`.

**Spec:** `docs/superpowers/specs/2026-11-17-interim-weekly-billing-design.md` (read it first; this plan only records decisions the spec leaves to the builder).

## Global Constraints

- Every new file starts with the banner `TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.` (as a comment; for `.sh`, `.sql` and `.md` files too).
- All code under `src/interimBilling/`; tests under `__tests__/interimBilling/`; tables only `interim_billing_*`; settings only `INTERIM_BILLING_*` plus `STRIPE_SANDBOX_SECRET_KEY` and `STRIPE_LIVE_SECRET_KEY`. The only hooks outside the folder are the five in Task 12.
- Money is integer cents; fee percentage is integer basis points; fee = `linehaulCents * basisPoints / 10000` rounded half-up; currency `USD` only; Stripe minimum invoice total `MIN_CHARGE_CENTS = 50`. Never use floating point for money.
- Stripe invoices: `collection_method: "charge_automatically"`, `auto_advance: false`, statement descriptor `IRON WING DISPATCH`, payment method types `["card", "us_bank_account"]`; Stripe `apiVersion` pinned to `2026-10-28.endive`.
- Scope of this plan is **sandbox only**: no live Stripe key, no ssh to `kelevo-prod`, nothing applied to any server. The production artifacts in Task 5 are written and tested locally and are **not applied**.
- Logs carry ids, counts and status codes only: never names, emails, amounts per carrier, payment details, keys, or raw Stripe/SSH error text (map to codes).
- No card or bank numbers are stored; store only Stripe `pm_...` ids with brand and last four.
- Mode guards: `INTERIM_BILLING_MODE` is `sandbox` or `live`. Sandbox requires `STRIPE_SANDBOX_SECRET_KEY` starting `sk_test_` or `rk_test_`; live requires `STRIPE_LIVE_SECRET_KEY` starting `rk_live_` and `INTERIM_BILLING_LIVE_CONFIRM=yes`. The module is off unless `INTERIM_BILLING_ENABLED=true`.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. After `npm ci` run `npx prisma generate` before tests. Run the whole suite with `npm test`. Integration tests are `*.integration.test.js` and need `.env.test` and a database named `*_test`.
- Format changed files only with `npx prettier --write <files>` (repo style: 4 spaces, double quotes). Never format whole directories.
- Never open `.env`, `.env.*` or key files; never print secrets.
- Work on branch `feat/interim-weekly-billing`. One commit per task; end each commit message with the `Co-Authored-By` line for the model doing the work. Do not push, merge or deploy.

## Review Focus

1. **Daylight saving:** the run end for weeks containing a fall-back or spring-forward Sunday must be the right UTC instant (Task 3).
2. **Bank debit in `processing`:** must never trigger a second attempt; only a failure does (Task 10).
3. **Crash between a Stripe write and the database write:** a rerun reconciles by listing the customer's invoices by metadata and creates no duplicate invoice or item (Task 9).
4. **A load seen twice (rerun, overlapping windows):** billed once, enforced by the `(kelevo_load_id, kind)` unique key (Tasks 4, 9).
5. **Hostile input:** malformed or oversized SSH output is rejected; carrier names with quotes, HTML or control characters never break invoice text; an approval with a stale count or total is refused (Tasks 5, 9).

---

## File structure

```
src/interimBilling/
  config.js            settings + mode/key guards
  money.js             cents, fee, formatting, line description
  schedule.js          run end in a time zone, business days, holidays
  store.js             Prisma data access with atomic claims
  kelevoReader.js      ssh read of KelevoTMS loads + validation (+ sandbox file source)
  classify.js          one KelevoTMS load -> ledger decision
  stripeClient.js      the only file that talks to Stripe
  adminAuth.js         bearer-token middleware (own token)
  carriers.js          carrier create, setup link
  runService.js        start run / dry run, linehaul, decide, approve
  retryPolicy.js       pure retry schedule
  charger.js           finalise, email statement, pay, apply outcome, due retries
  webhook.js           raw-body capture, signature check, event handlers
  scheduler.js         15-minute tick, startup reconciliation
  routes.js            Express router (admin API + webhook)
  index.js             exports used by the hooks
  README.md  DISPOSE.md  SANDBOX-TEST.md
  ops/kelevo-prod/     production artifacts (NOT applied): SQL, script, key/sudoers examples
__tests__/interimBilling/   one test file per source file, plus ops script test
prisma/schema.prisma        marked model block (hook) + migration
```

---

### Task 1: Branch, dependency, config with mode guards

**Files:**
- Create: `src/interimBilling/config.js`, `src/interimBilling/README.md`, `__tests__/interimBilling/config.test.js`
- Modify: `package.json` / `package-lock.json` (add `stripe`)

**Interfaces:**
- Produces: `getInterimBillingConfig(env = process.env) -> Config` and `class InterimBillingConfigError extends Error`. `Config` is `{ enabled: boolean }` when disabled, otherwise `{ enabled: true, mode, timezone, runHour, startDate: Date, autoRun, ssh: { host, user, keyFile, knownHostsFile }, loadsFile: string|null, stripe: { secretKey, webhookSecret, productId, apiVersion }, adminEmail, adminToken }`.
- Environment names: `INTERIM_BILLING_ENABLED`, `_MODE`, `_LIVE_CONFIRM`, `_TIMEZONE` (default `America/Chicago`), `_RUN_HOUR` (default 6), `_START_DATE` (ISO date, required), `_AUTO_RUN`, `_KELEVO_SSH_HOST`, `_KELEVO_SSH_USER`, `_KELEVO_SSH_KEY_FILE`, `_KELEVO_SSH_KNOWN_HOSTS_FILE`, `_LOADS_FILE` (sandbox only), `_STRIPE_WEBHOOK_SECRET`, `_PRODUCT_ID`, `_ADMIN_EMAIL`, `_ADMIN_TOKEN`.

- [ ] **Step 1: Branch and install.** `git checkout -b feat/interim-weekly-billing`; `npm install stripe`; confirm `new Stripe("sk_test_x", { apiVersion: "2026-10-28.endive" })` constructs without error in a one-line node check (if the SDK rejects that version string, stop and report).
- [ ] **Step 2: Write the failing tests** in `config.test.js`: disabled env returns `{ enabled: false }` without validating anything else; sandbox rejects a key starting `sk_live_`; sandbox rejects a missing key; sandbox accepts `sk_test_` and `rk_test_`; live rejects a non-`rk_live_` key and rejects missing `LIVE_CONFIRM=yes`; defaults (`America/Chicago`, 6, `autoRun` false); missing `START_DATE` throws; an admin token under 32 characters throws; `loadsFile` is refused when mode is `live`; `stripe.apiVersion` is `"2026-10-28.endive"`.
- [ ] **Step 3: Run:** `npx jest __tests__/interimBilling/config.test.js`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `config.js` as specified; read the key from `STRIPE_SANDBOX_SECRET_KEY` or `STRIPE_LIVE_SECRET_KEY` by mode; error messages never contain the key.
- [ ] **Step 5: Run the same tests.** Expected: PASS. Add a short `README.md` (what this is, the banner, link to the spec and `DISPOSE.md`).
- [ ] **Step 6: Commit** `feat(interim-billing): config with mode and key guards`.

### Task 2: Money helpers

**Files:** Create `src/interimBilling/money.js`, `__tests__/interimBilling/money.test.js`

**Interfaces:**
- Produces: `toCents(value: string|number|null|undefined) -> number|null`; `feeCents(linehaulCents: number, basisPoints: number) -> number`; `formatUsd(cents: number) -> string`; `describeLine({ kind, loadNumber, occurredAt, linehaulCents, feeBp, feeCents }, timeZone) -> string`; `MIN_CHARGE_CENTS = 50`.

- [ ] **Step 1: Failing tests.** `toCents("2400.00") === 240000`; `toCents("0.07") === 7`; `toCents("12.5") === 1250`; `toCents(null) === null`; `toCents("")  === null`; throws on `"1.234"`, `"-1"`, `"abc"`, `NaN`. `feeCents(240000, 500) === 12000`; `feeCents(12345, 500) === 617`; `feeCents(10, 500) === 1` (half-up); `feeCents(9, 500) === 0`; `feeCents(100, 1000) === 10`. `formatUsd(240000) === "$2,400.00"`; `formatUsd(5) === "$0.05"`. `describeLine` for a delivered load 1234 on 2026-11-18 at 5% returns `Load 1234, delivered Wed Nov 18: linehaul $2,400.00 x 5% = $120.00`; a 7.5% fee shows `7.5%`; a carrier name or control characters never appear (the function takes none); a cancelled load reads `cancelled` instead of `delivered`.
- [ ] **Step 2: Run** the file; Expected: FAIL.
- [ ] **Step 3: Implement.** Parse decimals from the string form with integer arithmetic (split on `.`), never `parseFloat`; `feeCents` uses integer math `Math.floor((linehaulCents * bp * 2 + 10000) / 20000)`.
- [ ] **Step 4: Run;** Expected: PASS.
- [ ] **Step 5: Commit** `feat(interim-billing): money helpers`.

### Task 3: Schedule helpers

**Files:** Create `src/interimBilling/schedule.js`, `__tests__/interimBilling/schedule.test.js`

**Interfaces:**
- Produces: `runEndUtc(now: Date, timeZone: string) -> Date` (the latest Monday 00:00 local time that is at or before `now`, as a UTC instant); `addBusinessDays(from: Date, days: number, timeZone: string) -> Date` (skips Saturday, Sunday and US federal holidays for 2026 and 2027 including observed dates; keeps the local clock time); `isRunDue(now: Date, timeZone: string, runHour: number) -> boolean` (local weekday is Friday and local hour is at least `runHour`). Use `Intl.DateTimeFormat`; add no dependency.

- [ ] **Step 1: Failing tests** (zone `America/Chicago`): `runEndUtc(2026-11-20T11:00:00Z)` is `2026-11-16T06:00:00Z`; `runEndUtc(2026-11-02T03:00:00Z)` is `2026-10-26T05:00:00Z` (Sunday evening local, week that contained the fall-back); `runEndUtc(2026-11-02T06:00:00Z)` is `2026-11-02T06:00:00Z` (exactly Monday 00:00 local); `runEndUtc(2027-03-17T12:00:00Z)` is `2027-03-15T05:00:00Z` (after spring-forward). `addBusinessDays(2026-11-20T16:00:00Z, 1)` is `2026-11-23T16:00:00Z`; `addBusinessDays(2026-11-23T16:00:00Z, 3)` is `2026-11-27T16:00:00Z` (Thanksgiving, 26 Nov 2026, skipped); a Saturday input moves to Monday for +1. `isRunDue` true on Friday 2026-11-20T12:00:00Z, false on Friday 2026-11-20T10:00:00Z (04:00 local) and false on Thursday.
- [ ] **Step 2: Run;** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions and an exported `US_FEDERAL_HOLIDAYS` set of `YYYY-MM-DD` strings.
- [ ] **Step 4: Run;** Expected: PASS.
- [ ] **Step 5: Commit** `feat(interim-billing): run end and business-day helpers`.

### Task 4: Prisma models, migration, store

**Files:**
- Modify: `prisma/schema.prisma` (append a marked block), create the migration folder `prisma/migrations/20261117120000_interim_billing/migration.sql`
- Create: `src/interimBilling/store.js`, `__tests__/interimBilling/store.integration.test.js`

**Interfaces:**
- Models (Prisma names → tables): `InterimBillingCarrier` → `interim_billing_carrier`, `InterimBillingCarrierAsset` → `..._carrier_asset`, `InterimBillingRun` → `..._run`, `InterimBillingLine` → `..._line`, `InterimBillingInvoice` → `..._invoice`, `InterimBillingStripeEvent` → `..._stripe_event`. Fields exactly as in the spec ("This module's tables"); the run is unique on `run_end`; the line is unique on `(kelevo_load_id, kind)`; carrier asset unique on `(kind, kelevo_id)`; statuses are strings.
- Produces (store.js, all async): `claimRun(runEnd: Date) -> { run, created: boolean }`; `transitionRun(runId, fromStatuses: string[], toStatus: string, data?: object) -> boolean` (atomic `updateMany`, true only if exactly one row changed); `insertLinesIfAbsent(lines: LineInsert[]) -> number` (inserts new, skips existing, returns inserted count); `getLine(id)`; `updateLineIf(id, fromStatuses, patch) -> boolean`; `listLinesForRun(runId)`; `listReadyLinesWithoutInvoice()`; `createInvoiceRow(data)`; `transitionInvoice(id, fromStatuses, toStatus, data?) -> boolean`; `getInvoice(id)`; `listDueRetries(now: Date)`; `recordStripeEvent(eventId, tx?) -> boolean` (false if already seen); `getCarrier(id)`, `listCarriers()`, `findCarrierByAsset(kind, kelevoId)`; `createCarrier(data)`; `setPaymentMethod(carrierId, role, { pmId, brand, last4 })`.

- [ ] **Step 1: Write the failing integration tests** (`*.integration.test.js`, using the repo's `setup-integration`): `claimRun` called twice for the same end returns `created: true` then `false`; `transitionRun` returns true once and false the second time for the same `from`; `insertLinesIfAbsent` with the same `(loadId, kind)` twice inserts once; `recordStripeEvent` returns true then false; two concurrent `transitionRun` calls (Promise.all) yield exactly one `true`. Each test cleans its own `interim_billing_*` rows.
- [ ] **Step 2: Run** `npm run test:integration -- __tests__/interimBilling/store.integration.test.js`. Expected: FAIL (tables missing).
- [ ] **Step 3: Add the models** to the end of `schema.prisma` inside a block commented `// TEMPORARY: interim billing models. Delete with the feature. See src/interimBilling/DISPOSE.md.`, write the migration SQL by hand to match (create tables, unique indexes, `CHECK` on `fee_bp > 0`), then `npx prisma generate` and `npm run db:test:setup`.
- [ ] **Step 4: Implement `store.js`** with the atomic functions using `updateMany` and unique constraints, not read-then-write.
- [ ] **Step 5: Run the integration tests;** Expected: PASS. Run `npm test` for regressions.
- [ ] **Step 6: Commit** `feat(interim-billing): ledger tables and store`.

### Task 5: Reader for KelevoTMS loads, and the production artifacts

**Files:**
- Create: `src/interimBilling/kelevoReader.js`, `src/interimBilling/ops/kelevo-prod/{README.md,01-iwd_billing_loads.sql,export-loads.sh,authorized_keys.example,sudoers.example}`, `__tests__/interimBilling/kelevoReader.test.js`, `__tests__/interimBilling/exportScript.test.js`

**Interfaces:**
- Produces: `type KelevoLoad = { id: number, loadNumber: number|null, status: "DELIVERED"|"PAID"|"CANCELED", driverId: number|null, truckId: number|null, rateCents: number|null, currency: string, enteredLinehaulCents: number|null, deliveredAt: Date|null, deliveryEnd: Date|null, canceledAt: Date|null }`; `parseLoadRows(text: string) -> KelevoLoad[]` (throws `KelevoReadError` with a short code); `fetchLoads({ from: Date, to: Date }, config, run = execFile) -> Promise<KelevoLoad[]>`.
- The SQL function is `iwd_billing_loads(from_ts timestamptz, to_ts timestamptz)` returning rows with the columns in the spec; it takes Iron Wing's organization id as a placeholder `__IRON_WING_ORG_ID__` that the owner fills in at apply time.

- [ ] **Step 1: Failing reader tests:** `parseLoadRows` accepts a valid array and converts decimal strings to cents and dates to `Date`; rejects invalid JSON, a non-array, an unknown `status`, a negative or non-numeric amount, a row missing `id`, more than 5000 rows, and output over 2 MB (each with a distinct `KelevoReadError.code`); `fetchLoads` builds exactly one `ssh` invocation through the injected `run` (no shell) with `-i <key>`, `-o BatchMode=yes`, `-o StrictHostKeyChecking=yes`, `-o UserKnownHostsFile=<file>`, `-o ConnectTimeout=10`, target `user@host` and the single argument `"<fromIso> <toIso>"` in the form `2026-11-02T06:00:00Z 2026-11-09T06:00:00Z`, with a 30 s timeout; a non-zero exit or timeout throws `KelevoReadError` whose message contains no stderr text; when `config.loadsFile` is set, loads are read from that JSON file instead and `run` is never called.
- [ ] **Step 2: Failing script test** (`exportScript.test.js`): run `export-loads.sh` with `bash`, a stub `docker` first on `PATH` that records its arguments, and `SSH_ORIGINAL_COMMAND` set. A valid `"2026-11-02T06:00:00Z 2026-11-09T06:00:00Z"` calls the stub once with a single read-only `psql` call and the two timestamps passed as variables; each of these exits non-zero without calling the stub: empty value, one timestamp, three words, `"...; rm -rf /"`, a `$(...)` substitution, a newline, a timestamp with a different format, `from` later than `to`, a window over 400 days.
- [ ] **Step 3: Run both;** Expected: FAIL.
- [ ] **Step 4: Implement** `kelevoReader.js` (hand-written validators, `execFile` with `{ timeout: 30000, maxBuffer: 2 * 1024 * 1024 }`, the sandbox-only file source guarded by config) and the ops files: the SQL creates the login `iwd_billing_ro` and the `SECURITY DEFINER` plpgsql function with a fixed `search_path` and `EXECUTE` granted only to that login; the script validates with a strict regex and `date`, then runs the function as that login; `authorized_keys.example` shows `command=`, `restrict` and `from=` options; `sudoers.example` allows exactly the one script for the dedicated user. `ops/kelevo-prod/README.md` states in its first lines: **NOT APPLIED. Requires the owner's approval of the exact text before running on kelevo-prod.**
- [ ] **Step 5: Run both tests;** Expected: PASS.
- [ ] **Step 6: Commit** `feat(interim-billing): kelevo reader and production artifacts (not applied)`.

### Task 6: Classifier

**Files:** Create `src/interimBilling/classify.js`, `__tests__/interimBilling/classify.test.js`

**Interfaces:**
- Consumes: `KelevoLoad` (Task 5), `feeCents`, `MIN_CHARGE_CENTS` (Task 2).
- Produces: `classifyLoad(load: KelevoLoad, ctx: { carrierByDriver: Map<number, {id, feeBp}>, carrierByTruck: Map<number, {id, feeBp}>, startDate: Date, runEnd: Date }) -> LineDecision | null` where `LineDecision = { kelevoLoadId, loadNumber, kind: "DELIVERED"|"CARRIER_CANCELLED", carrierId: number|null, status: "ready"|"held", holdReason: null|"no_carrier"|"carrier_conflict"|"non_usd"|"needs_linehaul"|"cancelled_by_whom", allInRateCents: number|null, linehaulCents: number|null, feeBp: number|null, feeCents: number|null, occurredAt: Date }`. Returns `null` when the load is out of scope.

- [ ] **Step 1: Failing tests:** a delivered load with a driver mapping and `enteredLinehaulCents: 240000` at 500 bp is `ready` with fee 12000; delivered with no linehaul is `held` `needs_linehaul` and keeps `allInRateCents`; `PAID` is treated as delivered; delivery time is `deliveredAt`, else `deliveryEnd`, else `null` is out of scope; a load before `startDate` or at/after `runEnd` is `null`; unmapped driver and truck is `held` `no_carrier`; driver and truck mapped to different carriers is `held` `carrier_conflict`; driver unmapped but truck mapped uses the truck's carrier; `currency: "CAD"` is `held` `non_usd`; a `CANCELED` load with `canceledAt` in scope is kind `CARRIER_CANCELLED`, always `held` `cancelled_by_whom`; a `CANCELED` load without `canceledAt` is `null`.
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement** as a pure function. **Step 4: Run;** PASS.
- [ ] **Step 5: Commit** `feat(interim-billing): load classifier`.

### Task 7: Stripe client

**Files:** Create `src/interimBilling/stripeClient.js`, `__tests__/interimBilling/stripeClient.test.js`

**Interfaces:**
- Produces: `createStripeClient(stripeConfig, StripeCtor = Stripe) -> StripeApi` with `ensureCustomer({ carrierId, legalName, email }) -> { customerId }`; `createSetupSession({ customerId, carrierId, role, successUrl, cancelUrl }) -> { id, url }`; `retrieveSetupIntent(id)`; `retrievePaymentMethod(id)`; `createDraftInvoice({ customerId, runId, carrierId }) -> { invoiceId }`; `addInvoiceItem({ customerId, invoiceId, lineId, amountCents, description }) -> { itemId }`; `listInvoicesForRun(customerId, runId) -> { id, status, itemLineIds: number[] }[]`; `finalizeInvoice(invoiceId) -> { hostedInvoiceUrl, invoicePdf }`; `payInvoice(invoiceId, paymentMethodId) -> { outcome: "paid"|"processing"|"failed", paymentIntentId, errorCode }`; `retrieveInvoice(id)`; and an exported `AUTHORIZATION_TEXT` (the payment authorisation wording from `payment-authorization-form.md`, as plain text under 1,000 characters).

- [ ] **Step 1: Failing tests with a fake `StripeCtor`** that records calls: the constructor receives `{ apiVersion: "2026-10-28.endive" }`; `createSetupSession` sends `mode: "setup"`, `payment_method_types: ["card", "us_bank_account"]`, `locale: "en"`, `custom_text.submit.message` equal to `AUTHORIZATION_TEXT`, us_bank_account financial connections permission `payment_method`, metadata with the carrier id and role, and an idempotency key; `createDraftInvoice` sends `collection_method: "charge_automatically"`, `auto_advance: false`, `statement_descriptor: "IRON WING DISPATCH"`, `payment_settings.payment_method_types: ["card", "us_bank_account"]`, a footer containing the support email and phone, and metadata with the run id and carrier id; `addInvoiceItem` attaches with `invoice: <id>`, `currency: "usd"`, `price_data` that uses the configured product id and `unit_amount`, a description, and an idempotency key built from the line id; `payInvoice` returns `processing` when the PaymentIntent status is `processing`, `paid` when the invoice is paid, and `failed` with the Stripe decline code (no message text) when the SDK throws a card error; `listInvoicesForRun` filters by metadata (the list call is by customer, not search).
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement.** Every error thrown out of this file is a small `StripeCallError` with a code and no raw Stripe message.
- [ ] **Step 4: Run;** PASS. **Step 5: Commit** `feat(interim-billing): stripe client`.

### Task 8: Admin auth, carriers, setup link

**Files:** Create `src/interimBilling/adminAuth.js`, `src/interimBilling/carriers.js`, `__tests__/interimBilling/adminAuth.test.js`, `__tests__/interimBilling/carriers.test.js`

**Interfaces:**
- Produces: `requireInterimAdmin(getConfig) -> express middleware` (bearer token compared with `crypto.timingSafeEqual` on SHA-256 digests; fails closed with 401 when the module is disabled or the token is unset; 404 when disabled); `createCarrier(input, deps) -> { id }` with input `{ legalName, mc, usdot, email, feeBp, driverIds: number[], truckIds: number[] }` validated (`feeBp` integer 1 to 3000, a plausible email, at most 50 ids); `sendSetupLink(carrierId, role: "primary"|"backup", deps) -> { url }` (ensures the Stripe customer, creates the session, emails the link to the carrier with `emailClient`, and returns the url).

- [ ] **Step 1: Failing tests:** missing/wrong/short token gives 401; the lead-listing token `ADMIN_API_TOKEN` is not accepted; a valid token passes; disabled module gives 404; `createCarrier` rejects `feeBp` 0, 3001 and 5.5, rejects a driver id mapped to another carrier, stores assets for each id; `sendSetupLink` calls `ensureCustomer` once, builds success and cancel urls from `https://iron-wing-dispatching.com`, emails the link, and rejects an unknown role.
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement. Step 4: Run;** PASS. **Step 5: Commit** `feat(interim-billing): admin auth and carriers`.

### Task 9: Run service (start, dry run, linehaul, decide, approve)

**Files:** Create `src/interimBilling/runService.js`, `__tests__/interimBilling/runService.test.js`

**Interfaces:**
- Consumes: store (Task 4), `fetchLoads` (Task 5), `classifyLoad` (Task 6), `StripeApi` (Task 7), money and schedule helpers, `sendEmail`.
- Produces: `startRun({ now: Date, dryRun?: boolean }, deps) -> RunSummary` where `RunSummary = { runId: number|null, runEnd: Date, invoices: { carrierId, lineCount, totalCents }[], held: { lineId: number|null, kelevoLoadId, reason, allInRateCents, enteredLinehaulCents }[], canceledWithoutDate: number, totalCents: number }`; `setLinehaul(lineId, amount: string, note: string, deps) -> void`; `decideCancelled(lineId, charge: boolean, deps) -> void`; `approveRun(runId, { invoiceCount, totalCents }, approver: string, deps) -> void` (throws `StaleApprovalError`).

- [ ] **Step 1: Failing tests (all with fake store, reader, Stripe and mailer):**
  - A normal run claims the run, classifies, writes lines, creates one Stripe draft invoice per carrier with its items, moves the run to `awaiting_approval`, and emails the admin a summary (held lines listed with reasons).
  - A dry run calls no Stripe method, writes no ledger row and sends no email, and returns the same summary.
  - **Load seen twice:** two runs whose windows overlap bill a load once (Review Focus 4).
  - **Crash recovery:** if the first run stops after `createDraftInvoice` but before the invoice row is stored, a rerun finds that invoice through `listInvoicesForRun` and adds only the missing items (Review Focus 3).
  - Held cancelled loads stay held; `decideCancelled(true)` moves a line with a linehaul to `ready`, without one to `held` `needs_linehaul`; `decideCancelled(false)` moves it to `skipped`.
  - `setLinehaul` rejects non-positive amounts and requires a note; a line becomes `ready` and gains its fee.
  - An invoice total under `MIN_CHARGE_CENTS` returns its lines to `held` `below_minimum`, and they are included in the next run when the carrier's total reaches the minimum.
  - Items are described with `describeLine` only; a carrier name with quotes, HTML or control characters never reaches an invoice description (Review Focus 5).
  - `approveRun` with the right count and total moves `awaiting_approval` to `approved`; a different count or total, or a run not awaiting approval, throws `StaleApprovalError` and changes nothing.
  - `CANCELED` loads without `canceledAt` are counted in `canceledWithoutDate` and never billed.
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement** (persist intent before each Stripe call; use `transitionRun` for the claim and approval; late `ready` lines from earlier decisions are included via `listReadyLinesWithoutInvoice`). **Step 4: Run;** PASS.
- [ ] **Step 5: Commit** `feat(interim-billing): run service`.

### Task 10: Retry policy and charger

**Files:** Create `src/interimBilling/retryPolicy.js`, `src/interimBilling/charger.js`, `__tests__/interimBilling/retryPolicy.test.js`, `__tests__/interimBilling/charger.test.js`

**Interfaces:**
- Produces: `nextStep({ round: number, triedBackupThisRound: boolean, hasBackup: boolean, firstFailureAt: Date }, now: Date, timeZone: string) -> { action: "try", method: "primary"|"backup", at: Date, round: number } | { action: "give_up" }`; `chargeApprovedRun(runId, deps) -> void`; `applyPayOutcome(invoiceId, outcome, now, deps) -> void`; `runDueRetries(now, deps) -> number`.
- Rule (from the spec): round 0 is the first charge. A failed primary with a backup tries the backup immediately (same round). When all methods in a round fail, round 1 is scheduled at `firstFailureAt + 1 business day` and round 2 at `+ 3 business days`, each trying primary then backup; after round 2 fails, `give_up`.

- [ ] **Step 1: Failing policy tests:** primary fails, backup exists, round 0 gives `try backup` now; backup also fails gives `try primary` at +1 business day (round 1); round 1 both fail gives `try primary` at +3 business days (round 2); round 2 both fail gives `give_up`; no backup skips the backup tries; the +1/+3 dates skip weekends and 2026-11-26.
- [ ] **Step 2: Failing charger tests:** an approved run's invoices are claimed one at a time (`draft` to `finalizing`), finalised, a statement email carrying the hosted invoice link is sent to the carrier, and paid with the primary method; `outcome: "paid"` marks invoice and lines `paid`; **`outcome: "processing"` sets the invoice `processing`, schedules nothing and never calls `payInvoice` again, even if `chargeApprovedRun` or `runDueRetries` runs repeatedly (Review Focus 2)**; `failed` applies `nextStep`; `give_up` marks the invoice `failed` and emails the admin and the carrier; a run left `charging` can be resumed and skips invoices already past `draft`; `runDueRetries` pays only invoices whose `next_attempt_at` is due and returns the count; a carrier without a primary method is skipped and reported to the admin, not charged.
- [ ] **Step 3: Run;** FAIL. **Step 4: Implement. Step 5: Run;** PASS. **Step 6: Commit** `feat(interim-billing): retry policy and charger`.

### Task 11: Webhook

**Files:** Create `src/interimBilling/webhook.js`, `__tests__/interimBilling/webhook.test.js`

**Interfaces:**
- Produces: `interimBillingRawBody(req, res, buf) -> void` (the `verify` callback for `express.json()`; keeps `buf` on `req.rawBody` only when `req.originalUrl` starts with `/interim-billing/webhook`); `createWebhookHandler(deps) -> (req, res) -> Promise<void>`; `handleEvent(event, deps) -> Promise<void>`.

- [ ] **Step 1: Failing tests:** a body signed with the configured secret is accepted, a wrong or missing signature gets 400 and runs nothing; `interimBillingRawBody` keeps the raw bytes for the webhook path and nothing for other paths; the same event id twice has its effect once and returns 200 both times; the effect and the stored event id happen in one transaction (a failing effect leaves the event unrecorded); `setup_intent.succeeded` refetches the SetupIntent and PaymentMethod from Stripe (the event body is not trusted), stores `pm_...`, brand and last four for the carrier and role in the SetupIntent metadata, and ignores a payment method that is not `card` or `us_bank_account`; `invoice.paid` marks the invoice and lines `paid`; `invoice.payment_failed` calls `applyPayOutcome` with `failed` but does nothing while the PaymentIntent is `processing`; `charge.dispute.created` emails the admin and does not retry; an unknown event type returns 200.
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement** (signature check with `stripe.webhooks.constructEvent` through the Stripe client; logs carry the event id and type only). **Step 4: Run;** PASS. **Step 5: Commit** `feat(interim-billing): webhook`.

### Task 12: Router, scheduler, reconciliation, hooks

**Files:**
- Create: `src/interimBilling/routes.js`, `src/interimBilling/scheduler.js`, `src/interimBilling/index.js`, `__tests__/interimBilling/routes.test.js`, `__tests__/interimBilling/scheduler.test.js`
- Modify (each change carries the banner comment): `src/router.js` (one line mounting `/interim-billing`), `src/app.js` (the `verify` callback on `express.json()` and one line starting the scheduler after `listen`), `Dockerfile` (`openssh-client` in the apt install line), `docker-compose.yml` (read-only volume `/home/nick-kalas/apps/interim-billing-secrets:/run/interim-billing:ro`), `.github/workflows/ci-cd-pipeline.yml` (`INTERIM_BILLING_*` and `STRIPE_*` lines in the step that writes `.env`, from secrets of the same name)

**Interfaces:**
- Routes (all behind `requireInterimAdmin` except the webhook): `POST /carriers`, `POST /carriers/:id/setup-link`, `POST /runs` (`?dryRun=true`), `GET /runs/:id`, `POST /runs/:id/approve`, `POST /lines/:id/linehaul`, `POST /lines/:id/decide`, `POST /webhook`. Validation with `express-validator`; errors map to codes, never raw text.
- Produces: `startScheduler(deps, intervalMs = 900000) -> { stop() }` whose tick always runs `runDueRetries`, and starts a run only when `autoRun` is true, `isRunDue` is true and no run exists for that run end; `reconcileOnStart(deps)` resumes runs left `building` (rerun `startRun` for that end) and `charging` (rerun `chargeApprovedRun`); `startInterimBilling()` in `index.js` is a no-op when the module is disabled.

- [ ] **Step 1: Failing tests:** each route rejects a missing token (401) and a disabled module (404); `POST /runs` returns the summary and `?dryRun=true` calls `startRun` with `dryRun: true`; `POST /runs/:id/approve` with a stale total returns 409; `POST /lines/:id/linehaul` with `"abc"` returns 400; **the webhook path works through a full Express app that uses `express.json({ verify })` as `src/app.js` does (a signed JSON body verifies; the same app still parses JSON for other routes)**; a tick with `autoRun` false never starts a run but still processes due retries; a tick on Friday 06:00 local with `autoRun` true starts exactly one run even if called twice; `reconcileOnStart` resumes a `charging` run and a `building` run and ignores others; `startInterimBilling` does nothing when disabled.
- [ ] **Step 2: Run;** FAIL. **Step 3: Implement the router, scheduler and `index.js`, then the five hooks.**
- [ ] **Step 4: Run** `npm test` and `npm run test:integration`. Expected: all PASS, nothing outside the module changed behaviour. Run `npx eslint src/interimBilling` and fix findings in the new files only.
- [ ] **Step 5: Commit** `feat(interim-billing): routes, scheduler and hooks`.

### Task 13: Documentation and sandbox test

**Files:** Create `src/interimBilling/DISPOSE.md`, `src/interimBilling/SANDBOX-TEST.md`; finish `src/interimBilling/README.md`

- [ ] **Step 1: Write `DISPOSE.md`:** the banner; the disposal procedure from the spec ("Isolation and disposal"), listing the five hooks with file and exact lines, the Prisma block and a ready-made drop migration to add at that time, the settings and CI secrets to remove, the Stripe webhook endpoint and product, and the `kelevo-prod` items (key, script, sudoers rule, function, login) with the commands to remove them, plus the key files on the Hetzner host.
- [ ] **Step 2: Write `SANDBOX-TEST.md`:** how to run the whole flow in the Stripe sandbox with `INTERIM_BILLING_LOADS_FILE` pointing at a fake loads JSON (a sample is included in the file): create a carrier, send a setup link, complete it with test card `4242 4242 4242 4242` and the sandbox bank account, start a dry run, a real run, set a linehaul, decide a cancelled load, approve, watch the webhook, then repeat with a failing card (`4000 0000 0000 0341`) to see the backup and retry path. List the expected result at each step.
- [ ] **Step 3: Check the docs:** every file under `src/interimBilling` starts with the banner (add a test `__tests__/interimBilling/banner.test.js` that scans the folder), and each hook in `DISPOSE.md` exists in the code at the stated place.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `docs(interim-billing): disposal guide and sandbox test`.

---

## Self-review

- **Spec coverage:** reading loads (T5), tables (T4), carrier setup (T8), run steps 1 to 8 (T6, T9), outcomes and retry rule (T10), webhook (T11), isolation and the five hooks (T12, T13), safety rules (T1 guards, banner test, logging in each task), testing list (distributed; the `processing` rule in T10, DST in T3, duplicates in T4 and T9, malformed SSH output in T5, stale approval in T9). Dry run is T9, the scheduler default off is T12.
- **Additions the spec did not list (flagged):** the sandbox-only `INTERIM_BILLING_LOADS_FILE` source (T1, T5) so the sandbox test needs no production access; the carrier-without-primary report in T10.
- **Consistency:** `KelevoLoad`, `LineDecision`, `StripeApi`, `RunSummary` and the store function names are defined once and used with the same names later.
