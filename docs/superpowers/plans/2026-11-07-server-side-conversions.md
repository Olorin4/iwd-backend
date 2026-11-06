# Server-side Conversions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iwd-backend records every website form as a server-side PostHog event, stores the
Outreach `ref` and PostHog ID on the lead, and notifies Outreach by webhook. Neither PostHog nor
the webhook can ever affect the visitor's response.

**Architecture:**
- A middleware (`src/attribution.js`) runs after Turnstile. It captures the identity email before
  the sanitizers rewrite it, validates the two new body fields, moves them into `res.locals`, and
  removes them from `req.body`.
- Two small senders do the outbound work: `src/posthogServer.js` for PostHog and
  `src/outreachWebhook.js` for Outreach.
- The controllers save the fields, answer the visitor, then call `recordConversion`
  (`src/conversions.js`), which runs both senders and swallows their errors.

**Tech Stack:** Node.js (ESM), Express 4, Prisma 6 / PostgreSQL, Jest 29 with babel-jest,
`posthog-node`, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-07-server-side-conversions-design.md`. Read it first.

## Global Constraints

**Validation**
- `outreachRef` must match `/^[a-z2-7]{12}$/`.
- `posthogDistinctId` must be a string of 1–200 characters.
- An invalid value is dropped and never rejects the request.

**Identity email**
- It is `req.body.email` trimmed and lowercased, captured **before** the sanitizers.
- The stored lead email is unchanged.

**PostHog events**

| Form | Event | `conversion_tier` | Extra properties |
|---|---|---|---|
| sign-up | `lead_signed_up` | `primary` | `plan`, `fleet_size` (number or null), `trailer_type`, `has_phone` |
| contact | `contact_requested` | `secondary` | `has_phone` |
| newsletter | `newsletter_subscribed_server` | `secondary` | — |

- Every event also carries `form` (`"sign_up"` / `"contact"` / `"newsletter"`), `source: "server"`,
  `deployment_environment` (`"production"` when `NODE_ENV === "production"`, else
  `"development"`), and `outreach_ref` when present.
- `distinctId` is the identity email, with `$set: { email }`.
- When `posthogDistinctId` is present and differs from the email, first capture `$identify` with
  `distinctId: email` and `properties: { $anon_distinct_id: posthogDistinctId }`.
- Host `https://us.i.posthog.com`; the token comes from `POSTHOG_PROJECT_TOKEN`. Without the token,
  PostHog is a no-op.
- PostHog never receives names, phone numbers or message text.

**Webhook**
- It goes to `OUTREACH_CONVERSION_WEBHOOK_URL` with `Authorization: Bearer ${OUTREACH_WEBHOOK_TOKEN}`.
  It is disabled unless both are set.
- Body:

  ```
  { event_id: uuid, type: "sign_up"|"contact"|"newsletter", brand: "IRON_WING", outreach_ref: string|null, email, occurred_at: ISO, lead_id: number }
  ```

- It is sent when there is an `outreach_ref` or an email.
- Up to 3 attempts, about 1 s, 5 s and 30 s apart. Retry only on network errors and 5xx; a 2xx or
  4xx is final, and a 4xx is logged with its status.

**Repeat newsletter (`P2002`)**
- No event, no webhook, and the existing row is untouched.

**Turnstile, validation and rate limits**
- They are unchanged and run first. Nothing is captured or sent for a request that fails them.

**Database columns**
- `outreach_ref String?` and `posthog_distinct_id String?` on `sign_up_form`, `contact_submission`
  and `newsletter_subscriber`.

## Review Focus

- **A JSON body with `outreachRef: 123` or an object instead of a string** is dropped as invalid,
  not crashed on. → Task 1 test `drops non-string values`.
- **An email with surrounding spaces and capitals** (`"  John.Doe+X@Gmail.com "`) becomes the
  identity `john.doe+x@gmail.com`, while the stored email is still the sanitizer's output. →
  Task 1 test `captures the typed email before sanitizing` (and Task 5's route test).
- **PostHog's `capture` throwing synchronously** (for example a bad token) does not reject
  `recordConversion` or reach the visitor. → Task 4 test `swallows a throwing PostHog client`.
- **Outreach hanging without responding** is cut off by a per-attempt timeout (10 s) and counts as
  a network error. → Task 3 test `times out a hanging request and retries`.
- **The contact form still saves when the two fields are absent** (an old cached website), with
  null columns. → Task 5 test `saves a contact without attribution fields`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/attribution.js` (new) | `attributionFields` middleware, `OUTREACH_REF_PATTERN` |
| `src/posthogServer.js` (new) | posthog-node client, `captureConversion`, `shutdownPosthog` |
| `src/outreachWebhook.js` (new) | `notifyOutreach` with retries |
| `src/conversions.js` (new) | `recordConversion` (runs both, never throws) |
| `src/router.js` | inserts `attributionFields` after `requireTurnstile` on the 3 POST routes |
| `src/formsController.js`, `src/newsletterController.js` | store the fields; call `recordConversion` after responding |
| `src/app.js` | flush PostHog on SIGTERM/SIGINT |
| `prisma/schema.prisma`, `prisma/migrations/20261107120000_lead_attribution/migration.sql` | columns |
| `.github/workflows/ci-cd-pipeline.yml` | optional env lines |
| `iron-wing-dispatching/src/analytics.js`, `src/index.js`, `src/newsletter.js`, `src/sign-up-form/sign-up.js` | send the two fields |

---

### Task 1: Attribution middleware

**Files:** Create `src/attribution.js` and `__tests__/attribution.test.js`. Modify `src/router.js`.

**Interfaces:**
- Produces:
  - `attributionFields(req, res, next)`: sets `res.locals.identityEmail: string | null` and
    `res.locals.attribution = { outreachRef: string | null, posthogDistinctId: string | null }`,
    and deletes both fields from `req.body`.
  - `OUTREACH_REF_PATTERN = /^[a-z2-7]{12}$/`.

- [ ] **Step 1: Write the failing tests** in `__tests__/attribution.test.js`:
  - `keeps valid values`: body `{ email: "a@b.co", outreachRef: "abcdefghijk2", posthogDistinctId: "0192-anon" }` → `res.locals.attribution` equals `{ outreachRef: "abcdefghijk2", posthogDistinctId: "0192-anon" }`. `req.body` no longer has either key. `next` is called once.
  - `drops invalid values`: `outreachRef: "ABC"` and a 201-character `posthogDistinctId` → both null.
  - `drops non-string values`: `outreachRef: 123`, `posthogDistinctId: { a: 1 }` → both null, and no throw.
  - `captures the typed email before sanitizing`: `email: "  John.Doe+X@Gmail.com "` → `res.locals.identityEmail === "john.doe+x@gmail.com"`. `req.body.email` is unchanged by this middleware.
  - `missing email`: → `identityEmail === null`.
  - (in `__tests__/routes.test.js`) `attributionFields runs after requireTurnstile and before the validators` on `/sign-up-forms`, `/contact-forms` and `/newsletter`. Assert through the router stack order, or by making Turnstile fail and checking that `attributionFields` never ran.
- [ ] **Step 2: Run** `npx jest __tests__/attribution.test.js __tests__/routes.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/attribution.js` and insert `attributionFields` right after `requireTurnstile` in `src/router.js`, on all three POST routes.
- [ ] **Step 4: Run** the same command plus `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Read and validate website attribution fields before the sanitizers`.

### Task 2: Lead attribution columns

**Files:** Modify `prisma/schema.prisma` (models `SignUpForm`, `ContactSubmission`, `NewsletterSubscriber`). Create `prisma/migrations/20261107120000_lead_attribution/migration.sql`.

- [ ] **Step 1:** Add `outreach_ref String?` and `posthog_distinct_id String?` to the three models.
- [ ] **Step 2:** Write `migration.sql` as six `ALTER TABLE … ADD COLUMN … TEXT` statements (nullable, no default, no backfill) on `sign_up_form`, `contact_submission` and `newsletter_subscriber`. Then run `npx prisma generate`.
- [ ] **Step 3: Verify** on a scratch database only (`createdb iwd_tsl_scratch`, never `.env`'s `DB_URL`): `DATABASE_URL=… npx prisma migrate deploy` applies cleanly. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url …` prints no difference. Drop the scratch database afterwards.
- [ ] **Step 4: Commit** `Store the Outreach ref and PostHog ID on website leads`.

### Task 3: Outreach webhook sender

**Files:** Create `src/outreachWebhook.js` and `__tests__/outreachWebhook.test.js`.

**Interfaces:**
- Produces: `notifyOutreach({ type, outreachRef, email, leadId, occurredAt? }, { fetchImpl = fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), env = process.env } = {}): Promise<"sent" | "skipped" | "rejected" | "failed">`.
  - `skipped`: disabled, or no ref and no email.
  - `rejected`: a final 4xx.
  - `failed`: all attempts used.

- [ ] **Step 1: Write the failing tests:**
  - `skips when the URL or token is unset`.
  - `skips with no ref and no email`.
  - `sends the body and bearer token`:
    - assert method POST and `Content-Type: application/json`;
    - assert the exact header `Authorization: Bearer tok`;
    - assert the body keys `event_id` (a UUID), `type`, `brand: "IRON_WING"`, `outreach_ref`, `email`, `occurred_at`, `lead_id`.
  - `sends with only an email` (`outreach_ref: null`).
  - `retries on 503 then succeeds`: 2 calls, `sleep` called with 1000, result `"sent"`.
  - `does not retry on 400`: 1 call, result `"rejected"`.
  - `gives up after 3 attempts on network errors`: 3 calls, sleeps 1000 then 5000, result `"failed"`.
  - `times out a hanging request and retries`: the first `fetchImpl` never resolves. Expect an `AbortSignal` with a 10 s timeout, and the retry happens.
  - `uses one event_id across retries`.
- [ ] **Step 2: Run** `npx jest __tests__/outreachWebhook.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.randomUUID()`, `AbortSignal.timeout(10000)`, and delays of `[1000, 5000]` between the 3 attempts. The spec's third delay (30 s) is not needed with 3 attempts (2 waits). Log through `src/logging.js`'s logger.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Notify Outreach of website conversions, with retries`.

### Task 4: PostHog server client and recordConversion

**Files:** Create `src/posthogServer.js`, `src/conversions.js`, `__tests__/posthogServer.test.js` and `__tests__/conversions.test.js`. Run `npm install posthog-node`.

**Interfaces:**
- Produces:
  - `captureConversion({ event, identityEmail, posthogDistinctId, outreachRef, properties }, { client } = {}): void`. It is a no-op without `POSTHOG_PROJECT_TOKEN` or an `identityEmail`.
  - `shutdownPosthog(): Promise<void>`.
  - `recordConversion({ type: "sign_up" | "contact" | "newsletter", leadId, identityEmail, attribution, properties }): Promise<void>`. It never rejects. It maps `type` to the event and `conversion_tier` from Global Constraints, calls `captureConversion`, then `notifyOutreach`, and logs any error.

- [ ] **Step 1: Write the failing tests:**
  - `posthogServer`: `captures with the email as distinctId and $set` — with a fake client, assert `capture({ distinctId: "a@b.co", event: "lead_signed_up", properties: { ..., $set: { email: "a@b.co" } } })`.
  - `posthogServer`: `merges the anonymous ID first` — with `posthogDistinctId: "anon-1"`, the first capture is `$identify` with `$anon_distinct_id: "anon-1"`.
  - `posthogServer`: `does not merge when the ID equals the email`.
  - `posthogServer`: `is a no-op without a token`.
  - `conversions`: `maps each type to its event and tier`. For all 3 types, the properties include `form`, `source: "server"`, `deployment_environment`, and `outreach_ref` only when present.
  - `conversions`: `never sends name, phone or message`.
  - `conversions`: `swallows a throwing PostHog client` — the capture throws synchronously, `recordConversion` resolves, and `notifyOutreach` is still called.
  - `conversions`: `swallows a rejected webhook`.
- [ ] **Step 2: Run** `npx jest __tests__/posthogServer.test.js __tests__/conversions.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create the posthog-node client lazily with `{ host: "https://us.i.posthog.com", flushAt: 1, flushInterval: 0 }`, so a low-traffic server sends at once.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Record website conversions in PostHog from the server`.

### Task 5: Wire the three forms

**Files:** Modify `src/formsController.js`, `src/newsletterController.js` and `src/app.js`. Test: `__tests__/signUpForm.test.js`, `__tests__/routes.test.js`, and a new `__tests__/conversionsWiring.test.js`.

**Interfaces:**
- Consumes: `res.locals.identityEmail` and `res.locals.attribution` (Task 1), the columns (Task 2), and `recordConversion` (Task 4, mocked in these tests).

- [ ] **Step 1: Write the failing tests:**
  - `sign-up stores outreach_ref and posthog_distinct_id`.
  - `sign-up calls recordConversion after responding`: `type: "sign_up"`, `leadId`, `identityEmail`, `attribution`, and properties `{ plan, fleet_size: Number(fleetSize) || null, trailer_type, has_phone }`.
  - `saves a contact without attribution fields`: null columns, `recordConversion` called with `type: "contact"`.
  - `contact never saves unknown body keys` (Prisma `data` contains only `email`, `phone`, `message` and the two columns).
  - `newsletter new subscriber records a conversion`.
  - `newsletter repeat (P2002) records nothing and stays 200`.
  - `a rejected recordConversion does not change the response`.
  - `validation failure records nothing`.
  - `app flushes PostHog on SIGTERM`: export a `registerShutdown(process, shutdownPosthog)` helper from `src/app.js`, or test it in isolation.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Sign-up and newsletter add the two columns to `create.data`.
  - Contact builds `data` explicitly: `{ email, phone, message, outreach_ref, posthog_distinct_id }`.
  - Each handler sends its response first, then calls `void recordConversion(...)`.
  - `app.js` registers SIGTERM/SIGINT handlers that `await shutdownPosthog()`, then exit.
- [ ] **Step 4: Run** `npm test` and `npm run lint`. Expected: PASS.
- [ ] **Step 5:** In `.github/workflows/ci-cd-pipeline.yml`, add these three lines next to the other `.env` echoes:

  ```
  echo "POSTHOG_PROJECT_TOKEN=${{ secrets.POSTHOG_PROJECT_TOKEN }}" >> .env
  echo "OUTREACH_CONVERSION_WEBHOOK_URL=${{ secrets.OUTREACH_CONVERSION_WEBHOOK_URL }}" >> .env
  echo "OUTREACH_WEBHOOK_TOKEN=${{ secrets.OUTREACH_WEBHOOK_TOKEN }}" >> .env
  ```

  Empty secrets give empty values, which means disabled. Validate the YAML.
- [ ] **Step 6: Commit** `Send website conversions to PostHog and Outreach after each form`.

### Task 6: Website sends the two fields

**Repo:** `~/web-dev/iron-wing-dispatching`. Work on branch `feat/attribution-fields`. Do not merge: `master` deploys to production, and the backend must ship first.

**Files:** Modify `src/analytics.js`, `src/index.js` (contact), `src/newsletter.js` and `src/sign-up-form/sign-up.js`.

**Interfaces:**
- Produces: `attributionFields(): { outreachRef: string | null, posthogDistinctId: string | null }` in `src/analytics.js`.
  - When analytics is enabled: `outreachRef` comes from `posthog.get_property("outreach_ref")`, and `posthogDistinctId` from `posthog.get_distinct_id()`.
  - When analytics is off: both are null.

- [ ] **Step 1:** Implement `attributionFields()`, and spread `...attributionFields()` into the JSON body of each of the 3 `fetch` calls.
- [ ] **Step 2: Verify.**
  - `npm run build` passes, and eslint is clean on the 4 files.
  - Run the built site under preview with Playwright from `/home/olorin4/web-dev/kelevoTMS/node_modules/playwright`.
  - Intercept the three POSTs (route them to a stub, so nothing reaches the real API) and assert each body has `outreachRef` and `posthogDistinctId` after visiting `/?ref=abcdefghijk2`.
  - Abort all PostHog requests during the run.
- [ ] **Step 3: Commit** `Send the Outreach ref and PostHog ID with each form`.

### Task 7: Whole-change check

- [ ] **Step 1:** In iwd-backend, run `npm test`, `npm run lint` and the integration tests (`npm run db:test:create && npm run db:test:setup && npm run test:integration`; these use the `iwd_test` database). Expected: all PASS.
- [ ] **Step 2:** Leave the release to the owner, in this order:
  1. Set the GitHub secret `POSTHOG_PROJECT_TOKEN` (the project 502839 token). Leave the two webhook secrets empty until step 4.
  2. Merge and deploy iwd-backend, including `prisma migrate deploy` on production.
  3. Merge `feat/attribution-fields` on the website.
