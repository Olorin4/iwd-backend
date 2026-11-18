# Client onboarding (permanent module)

Code: `src/clients/`, `src/onboarding/`, `src/payments/`. Design: workflow
modernization design §2, §5–§8 (Outreach repo,
`docs/superpowers/specs/2026-11-18-workflow-modernization-design.md`).
This module never imports `src/interimBilling/` (architecture test) and does
not change interim billing. Interim billing may later _read_ a Client through
`src/clients/index.js` in a separately approved change.

Status: implemented and tested with fakes only. **No SignWell, Stripe or SMTP
call has been made.** The module is off by default.

## What it does

1. Outreach `PUT /onboarding/requests/:idempotencyKey` (`onboarding.request.v1`,
   bearer + HMAC) creates an onboarding request and matches or creates a
   Client by USDOT. Same key and hash → 200; different terms → 409.
2. After commit, the approved document bundle is filled with the confirmed
   values (text stamps only) and sent with SignWell: draft first, then send.
   Carrier signs first, then the Iron Wing countersigner.
3. When the re-fetched SignWell document is `completed`, the completed PDF
   (with audit page) is stored encrypted and a Stripe Checkout session in
   `mode: setup` is created for exactly the agreed payment methods. One plain
   email with the continue link goes to `terms.recipient_email`.
4. Stripe webhooks are verified, deduplicated and re-fetched; `READY` only
   after the SetupIntent succeeded and the payment method belongs to the
   client's customer. ACH micro-deposits stay `PENDING_VERIFICATION`.
5. Provisioning: the `manual` adapter (default) sets `MANUAL_REQUIRED`; an
   operator provisions in Kelevo and calls `confirm_provisioning` with the
   Kelevo reference. The `kelevo` adapter is a stub (`kelevo_api_unavailable`)
   until Kelevo PRD-0020.
6. Operations checklist items are verified by actions. Readiness is `READY`
   only when signature `COMPLETED`, payment `READY`, provisioning
   `SUCCEEDED|MANUAL_CONFIRMED` and every checklist item is verified.
7. Every facet change bumps `version` and writes the full
   `onboarding.status.v1` payload to `onboarding_event` in the same
   transaction; the outbox delivers it to Outreach.

## Endpoints (all 404 unless `ONBOARDING_ENABLED=1`)

| Route                                            | Auth                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `PUT /onboarding/requests/:key`                  | bearer `IWD_ONBOARDING_TOKEN` + `X-IW-Signature`          |
| `GET /onboarding/requests/:key`                  | same                                                      |
| `POST /onboarding/requests/:key/actions/:action` | same + replay guard; body `{ actor: { user_id, email } }` |
| `GET /onboarding/requests/:key/documents/signed` | same + `X-IW-Actor-Id`, `X-IW-Actor-Email`; logged        |
| `POST /onboarding/webhooks/signwell`             | SignWell event hash (hint only; re-fetch)                 |
| `POST /onboarding/webhooks/stripe`               | Stripe signature with `ONBOARDING_STRIPE_WEBHOOK_SECRET`  |
| `GET /onboarding/continue/:token`                | signed, expiring token (SignWell redirect, payment email) |

`X-IW-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
±300 s. The signature covers only the timestamp and body; any reused
signature is rejected on every action path. Invalid configuration while
enabled → 503 `onboarding_config_invalid`.

Actions: `reconcile`, `resend_payment_link`, `reissue_packet` (only after
DECLINED/EXPIRED/CANCELLED/ERROR), `retry_provisioning`,
`confirm_provisioning` (`kelevo_ref`), `verify_operation_item` (`key`,
optional `note`), `cancel` (`reason`). Every attempt is audited as an
`audit.action.*` event with its actor. Refusals return 409
`action_not_allowed` with a `code`.

### Terms hash

`terms_hash` = lowercase hex SHA-256 of the UTF-8 canonical JSON of `terms`:
object keys sorted (JavaScript default sort) at every depth, array order
kept, no whitespace, values as `JSON.stringify` writes them. The receiver
recomputes it and rejects a mismatch with 422 `terms_hash_mismatch` (the
shared fixture carries a placeholder hash on purpose).

### SignWell webhook bounds

The SignWell hash covers only `type@time`, so events are hints: hashes must be
64 lowercase hex characters and times integers; events more than 10 minutes
from now are ignored (`stale_event`, 202); nothing is fetched unless the
document id is one of our own open envelopes; the dedupe key is
`type:time:<recomputed HMAC>:documentId`; webhooks re-fetch an envelope at most
once per 30 s. Legitimately late or throttled events are covered by the
reconcile poller (`ONBOARDING_RECONCILE_ENABLED=1`) and the `reconcile` action.
Orphan drafts from a timed-out create cannot email anyone and are left in
SignWell for manual deletion (the log shows `packet_create_failed`).

## Configuration

| Setting                                                                              | Notes                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ONBOARDING_ENABLED`                                                                 | `1` to enable. Anything else: routes 404, no workers.                                      |
| `IWD_ONBOARDING_TOKEN`                                                               | ≥32 chars; bearer from Outreach                                                            |
| `ONBOARDING_REQUEST_SIGNING_SECRET`                                                  | ≥32 chars; HMAC from Outreach; must differ from the token                                  |
| `ONBOARDING_PUBLIC_BASE_URL`                                                         | public https base of this API (continue links)                                             |
| `ONBOARDING_CONTINUE_TOKEN_SECRET`                                                   | ≥32 chars                                                                                  |
| `ONBOARDING_CONTINUE_TTL_DAYS`                                                       | default 30                                                                                 |
| `ONBOARDING_DOCUMENT_DIR`                                                            | private volume, not web-served                                                             |
| `ONBOARDING_DOCUMENT_KEY`                                                            | 32 random bytes, base64 (`openssl rand -base64 32`). Losing it loses the documents.        |
| `ONBOARDING_BUNDLE_NAME`                                                             | default `iron-wing-carrier-client`                                                         |
| `ONBOARDING_SIGNATURE_PROVIDER`                                                      | `signwell` (default) or `fake` (refused in production)                                     |
| `SIGNWELL_API_KEY`, `SIGNWELL_WEBHOOK_ID`                                            | SignWell API key and webhook id (the webhook HMAC key)                                     |
| `ONBOARDING_SIGNWELL_TEST_MODE`                                                      | default true; only `false`/`0`/`no` turns it off                                           |
| `ONBOARDING_SIGNWELL_EXPIRES_IN_DAYS`                                                | default 14                                                                                 |
| `ONBOARDING_SIGNWELL_TIMEOUT_MS`                                                     | default 15000                                                                              |
| `ONBOARDING_SIGNWELL_COORD_SCALE`, `_OFFSET_X`, `_OFFSET_Y`                          | layout points → SignWell coordinates; default scale 4/3, offsets 0 (calibrated; see below) |
| `ONBOARDING_COUNTERSIGNER_NAME`, `_TITLE`, `_EMAIL`                                  | Iron Wing countersigner (recipient 2, Dispatch)                                            |
| `ONBOARDING_STRIPE_SECRET_KEY`                                                       | `sk_test_`/`rk_test_` unless `ONBOARDING_STRIPE_LIVE_CONFIRM=yes`                          |
| `ONBOARDING_STRIPE_WEBHOOK_SECRET`                                                   | own endpoint secret (not the interim one)                                                  |
| `ONBOARDING_STRIPE_SUCCESS_URL`, `_CANCEL_URL`                                       | https pages shown after Checkout                                                           |
| `ONBOARDING_PROVISIONING_ADAPTER`                                                    | `manual` (default) or `kelevo` (stub)                                                      |
| `OUTREACH_STATUS_URL`, `ONBOARDING_STATUS_TOKEN`, `ONBOARDING_STATUS_SIGNING_SECRET` | all three enable the status outbox                                                         |
| `ONBOARDING_RECONCILE_ENABLED`                                                       | `1` runs the 15-minute reconciler                                                          |
| `ONBOARDING_EMAIL_FROM`                                                              | default `EMAIL_USER`                                                                       |

## SignWell coordinate calibration

Calibrated 2026-11-18 against release v1 (sha256 `98922710…43aa`): two
test-mode drafts were created without email, measured in SignWell's editor
and deleted (DELETE on a draft returns 204; GET then returns 404). SignWell
uses a top-left origin in CSS pixels at 96 DPI (letter page 816×1056), so
x, y, width and height are PDF points × 4/3. Verified within ~2 pt for x/y and
exactly for widths at the page 1 corners, the page 4 signature cell and the
page 6 signature line (46.5, 670.5, 175.2×19.5 pt → 62, 894, 233.6×26 px).
The conversion is the single function `toSignwellBox` in
`src/onboarding/signature/signwell.js`; the settings above override it.

Page-6 authorization date (owner decision 2026-11-18,
`owner_decisions: ["page6_date_typed_mm_dd_yy 2026-11-18"]` in the layout):
SignWell date fields render semi-transparent, so a date field over the printed
`__ / __ / 20__` showed the printed slashes through it. Page 6 therefore uses
three required, fixed-width Carrier **text** fields in the printed blanks
(MM, DD, and YY after the printed "20"), each with a custom pattern and a
plain-words error message. These are typed by the signer; the SignWell audit
page remains the authoritative signing time. Pages 4 and 5 keep their locked
date-signed fields.

Layout v1 approval (owner, 2026-11-18): the owner approved
`Iron-Wing-Onboarding-Packet-v1.layout.json` as final (`status: APPROVED`),
accepting that the Section 1 document checklist blanks stay empty and that the
Section 4 plan box is ticked from the confirmed terms before sending (the carrier
confirms it by signing). The file's `status` records the decision; a database
bundle still becomes APPROVED only through the `approve` CLI step below, which
the owner runs at deployment. Any wording or position change is a new layout
version, never an edit of this file.

## Migration

`prisma/migrations/20261118120000_client_onboarding` is additive: new tables
`client`, `onboarding_request`, `document_bundle_version`,
`signature_envelope`, `payment_setup`, `onboarding_event`,
`provider_webhook_receipt`, `document_access_log`, two partial unique indexes
(one live envelope and one open payment setup per request) and two triggers
(confirmed terms immutable; approved bundles immutable, only APPROVED →
RETIRED). Apply with `npx prisma migrate deploy` after the usual backup. The
partial indexes and triggers live only in SQL; `prisma migrate dev` drift
checks may report them.

## Enable order

1. Deploy with `ONBOARDING_ENABLED` unset; apply the migration.
2. Create the private document directory and key; back the key up offline.
3. Register the approved release PDF as a bundle and approve it (owner):
   `node -r dotenv/config scripts/onboarding-bundle.js register --name iron-wing-carrier-client --version 1 --pdf Iron-Wing-Onboarding-Packet-v1.pdf --expect-sha256 <release sha256> --layout <reviewed layout.json>`,
   then `... approve --id <id> --by "<owner>"`. The shipped layout
   `docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.json`
   is owner-approved (2026-11-18); register it unchanged with the release PDF.
4. Sandbox acceptance (`scripts/onboarding-sandbox.js`, test mode, ≤10 emails
   to one owner address) on a `_test`/`_sandbox` database.
5. Configure the SignWell webhook and the Stripe webhook endpoint
   (`/onboarding/webhooks/stripe`; events `checkout.session.completed`,
   `checkout.session.expired`, `setup_intent.succeeded`,
   `setup_intent.setup_failed`, `setup_intent.requires_action`).
6. Owner approves live keys; set them, then `ONBOARDING_ENABLED=1`, then the
   outbox settings, then `ONBOARDING_RECONCILE_ENABLED=1`.

## Recovery

| Situation                          | State / code                             | Action                                                       |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| No approved bundle                 | NOT_SENT `bundle_unavailable`            | approve a bundle, then `reconcile`                           |
| Draft create failed/timed out      | NOT_SENT `packet_create_failed`          | `reconcile` (new draft; old draft cannot email)              |
| Filling failed (overflow/encoding) | NOT_SENT `packet_fill_failed`            | fix the layout (new bundle version) or cancel and re-request |
| Send timed out                     | UNKNOWN `send_outcome_unknown`           | `reconcile` (GET; draft → send same id)                      |
| Send rejected                      | ERROR `send_rejected`                    | `reissue_packet`                                             |
| Declined / expired                 | readiness CLOSED                         | `reissue_packet`                                             |
| Checkout expired / setup failed    | FAILED `checkout_expired`/`setup_failed` | `resend_payment_link`                                        |
| Stripe call failed                 | FAILED `stripe_session_failed`           | `resend_payment_link`                                        |
| ACH micro-deposits                 | PENDING_VERIFICATION                     | wait; `reconcile` re-fetches                                 |
| No Kelevo API                      | MANUAL_REQUIRED                          | provision in Kelevo, `confirm_provisioning`                  |
| Outreach unreachable               | event retried with backoff (≤20)         | fix Outreach; 4xx other than 408/429 stops the event         |

## Rollback

Set `ONBOARDING_ENABLED` to anything but `1` (routes 404, workers stop) or
deploy the previous image. Stored requests, documents and events remain. The
migration is additive, so code rollback never needs a database rollback.
Removing interim billing later must keep the `/onboarding` raw-body parser
line in `src/app.js`, which sits before the interim parser.

## Changes outside the module

- `src/app.js`: import `onboardingRawBody, startOnboarding`;
  `app.use("/onboarding", express.json({ verify: onboardingRawBody }))` before
  the unchanged interim parser; `startOnboarding()` after interim start.
- `src/router.js`: `router.use("/onboarding", onboardingRouter)`.
- `package.json`: `zod`, `pdf-lib` (shifts the line numbers cited in
  `src/interimBilling/DISPOSE.md`; its code anchors remain authoritative).
