# Client onboarding (iwd-backend) — progress

Branch `feat/client-onboarding`. Design: outreach-modernize
`docs/superpowers/specs/2026-11-18-workflow-modernization-design.md` §2, §5, §6–§8; plan I1–I7.

Baseline before work: unit 283 passed (28 suites); integration 19 passed (2 suites);
lint had 2 pre-existing prettier errors in `src/logging.js` and 1 warning in `src/app.js`.

## Commits

- I1 3a87824 skeleton folders, zod + pdf-lib, migration 20261118120000_client_onboarding (partial unique indexes + immutability triggers), architecture test, fixtures copied
- I2 261ebab service auth (bearer + HMAC), PUT/GET requests, canonical terms hash, Client by USDOT, router mount + app.js raw-body line
- I6a 0ab8a02 readiness derivation (pure; readiness.js was in I2) exhaustive tests

## app.js / router.js changes (keep tiny)

- `src/app.js`: import `onboardingRawBody` from `./onboarding/index.js`; `app.use("/onboarding", express.json({ verify: onboardingRawBody }))` placed before the unchanged interim `express.json` line.
- `src/router.js`: import `onboardingRouter`; `router.use("/onboarding", onboardingRouter)`.

## Decisions

- Disabled module → 404 for every `/onboarding/*` route (task brief), not the design's 503. Invalid config while enabled → 503 `onboarding_config_invalid`.
- PUT/GET bodies are the `onboarding.status.v1` object itself (not wrapped).
- Replay guard (signature value recorded as a receipt) applies to POST actions only; PUT is deduplicated by its idempotency key, so identical concurrent PUTs still converge.
- Client.usdot is unique (nullable) so concurrent different requests for one carrier converge on one Client.
- I3 9d967df encrypted DocumentStore, bundle CLI (register/approve/retire/list), pdf-lib text stamper; synthetic test PDF + layout (no `pdftotext`/PDF text tools installed, so no DRAFT layout for the review `combined-packet.pdf` — coordinates remain an owner/orchestrator step)

## Owner ruling R5 (2026-11-18, via orchestrator)

The owner approved the Stripe-only payment-authorization adaptation
(`docs/operations/interim-onboarding-packet/payment-form-changes.md`). The onboarding
bundle is three documents: dispatch service agreement, limited power of attorney,
payment authorization form (Stripe-only). Packet files are not edited and no release
copies are generated here; release copies and field-coordinate review stay separate
owner/orchestrator steps. Sandbox/test fixtures may use the watermarked review copies
in test mode. Bundles support several files, so the three PDFs register as one version.

- I4 3c26d06 signature port, SignWell adapter + fake, webhook hint + re-fetch, completed PDF storage, UNKNOWN/reconcile, reissue
- I4-fix (next commit) bound SignWell webhook replay (security review): events >10 min from now → 202 `stale_event` (reconcile poller covers late deliveries); no provider call unless the id is one of our open envelopes; receipt key `type:time:hash:documentId`; ≤1 webhook-triggered re-fetch per envelope per 30 s (`signature_envelope.last_webhook_fetch_at`, added to the unreleased migration). Consequence: orphan drafts from a timed-out create are no longer deleted from the webhook (that needed fetching an unknown id); they are drafts that cannot email anyone and are left for manual cleanup.
- I4-fix2 60b9d74 strict SignWell hash (64 lowercase hex) and integer time (canonical decimal), receipt key built from the server-recomputed HMAC
- amend (next commit) contract amendment for `terms` (FLEET replaces CUSTOM; fleet_service_plan, truck_count, primary_payment_method, statement_email; fixture re-copied byte-identical); layout format switched to the reviewed draft format (top-left PDF points; stamp/stamp_check/signwell); reviewed DRAFT layout copied to `docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.json` (status stays DRAFT); filler fails closed with `field_overflow` (never below 7 pt, never clipped); SignWell boxes go through one calibration function (identity, top-left; `ONBOARDING_SIGNWELL_COORD_SCALE/_OFFSET_X/_OFFSET_Y`) and log `signwell_coordinates_uncalibrated` until `ONBOARDING_SIGNWELL_COORDS_CALIBRATED=1`; `ONBOARDING_COUNTERSIGNER_TITLE` added; bundle CLI `--expect-sha256` for the release copy (v1 sha256 98922710…43aa, 6 pages) and layout `sha256` must match the PDF.
- Decision: `primary_payment_method` check is stamped only when the terms carry one (both methods chosen); with a single method no primary box is marked.
- I5 243b2ff payments/stripe.js, payment link after COMPLETED (one email per issued link), continue link, Stripe webhook (raw body, own secret, livemode, dedupe, re-fetch, ownership), ACH pending, failure/expiry → resend; strict hex compare (found `Buffer.from(hex)` accepting trailing junk on the continue token)
- I6 (next commit) provisioning port (manual + Kelevo stub `kelevo_api_unavailable`), actions endpoint (audited, actor required, replay-guarded), signed document download (service auth + actor headers, DocumentAccessLog), status outbox (bearer + HMAC, backoff, permanent 4xx stop), workers behind switches; app.js gains `startOnboarding()` (no-op unless ONBOARDING_ENABLED=1)
- Note: the app-to-app HMAC covers only `t.body`, not method/path (contract §5). The replay store rejects any reuse of a signature on any path, which bounds cross-endpoint replay; binding the path would be a contract change.
- I6 ca92d2b provisioning, actions, signed documents, outbox, workers, `startOnboarding()` in app.js
- I7 (next commit) sandbox script (refuses without confirm/single recipient/test keys/test mode/budget file/_test|_sandbox DB; persisted ≤10 email budget, 4 per packet send + 1 per email; `--pdf` + `--sha256` must match) — NOT run; ops doc and PRD-0020 proposal
- I7 bc4c277 sandbox script + docs

## Final verification (2026-11-18)

- `DB_URL=…/iwd_onboarding_test npm test`: 44 suites, 396 tests passed (unit 338 incl. 55 new; integration 58 incl. 39 new). No `.env.test` exists in this worktree, so the explicit DB_URL was used.
- Integration project alone: 7 suites, 58 passed.
- `npm run lint`: only the 3 pre-existing problems (2 prettier errors in `src/logging.js`, 1 warning in `src/app.js`); none in new code.
- Test DB container removed.

## Not done / open

- Sandbox acceptance not run (by design). SignWell field coordinates are UNCALIBRATED; the v1 layout stays DRAFT.
- Orphan SignWell drafts (create timeout) are not auto-deleted after the replay fix; manual cleanup.
- Cancel withdraws the packet with SignWell DELETE (best effort); behaviour for a partially signed document is unverified against the real API.
- SignWell field type for names: no dedicated type used; the reviewed layout has none.
- calib (this commit) SignWell calibration applied: points × 4/3, top-left (calibrated 2026-11-18 against release v1); `signwell_coordinates_uncalibrated` warning and `ONBOARDING_SIGNWELL_COORDS_CALIBRATED` removed; layout file gains `calibration` metadata, status stays DRAFT pending the owner's page-6 date-field decision (semi-transparent date field shows the printed `__ / __ / 20__` slashes). Unit 338 passed, integration 58 passed, lint clean for new code.
- p6date (this commit) page-6 authorization date → three required fixed-width Carrier text fields (MM/DD/YY, custom regex + plain error message); layout format extended (text label/fixed_width/validation_regex/_error_message, top-level owner_decisions); pages 4/5 keep locked date fields; layout DRAFT; audit page authoritative. Unit 341 passed.

- layout v1 approved final by owner 2026-11-18: renamed to `docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.json`, status APPROVED, fields unchanged; owner decisions recorded (Section 1 checklist blank, Section 4 pre-stamped). DB approval remains the deploy-time `approve` CLI step.

## Review fixes R1–R8 (2026-11-18)

- R1 7cc1ca6 request signature v2 on the Outreach link (method + originalUrl + actor headers + body sha256; v1 refused `signature_v1_rejected`; body actor must equal signed headers `actor_mismatch`; replay store on all methods incl. GETs → 401 `replayed_signature`, key `outreach:v2:<hex>`; access log uses the signed actor, email lower-cased). Test vector (secret "s"×32, t=1700000000, GET `/onboarding/requests/0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b/documents/signed`, actor 55555555-5555-4555-8555-555555555555 / closer@example.test, empty body) → `v2=977cc0d7d049974bfb323c24fab8a596ff19b36555e2f9f38024eff0ec8fd6b4` (cross-checked with openssl). Note: every Outreach GET now adds a receipt row; no pruning job exists yet.
- harness 50c102e test harness never reuses a default signature timestamp (every accepted v2 signature is a receipt)
- R2 34dce70 crash recovery sweeps (worker run-once + `reconcile` action): COMPLETED+NOT_STARTED → initial payment link; READY+NOT_STARTED → startProvisioning; PENDING >10 min → FAILED `provisioning_stale`; NOT_SENT older than 10 min (any code) → reconcileSignature. Not covered: a payment_setup stuck in CREATING (crash during the Stripe call) still answers `in_progress`.
- R3 5f8b833 + docs daa728b outbox: per-delivery timestamp, 401/403/404 slow retry (15 min doubling, cap 6 h, within MAX_ATTEMPTS), `redirect: "manual"` (3xx retried)
- R4 93bfef8 cancel re-checked under the request lock before createEnvelope and before send (delete draft, envelope CANCELLED); reissue withdraws a non-final superseded envelope's document (log `onboarding_reissue_withdraw_failed`)
- R5 c905e57 SignWell webhook: receiptExists → throttle → recordReceipt (throttled events keep their receipt)
- R6 9f95394 send success write `onlyFrom: PRE_SEND`; applySetupIntent re-checks SUCCEEDED under the lock
- R7 e3a7cff completed PDF must have more pages than the filled packet outside test mode, else envelope stays SENT/VIEWED with `audit_page_missing` (BLOCKED, action reconcile; readiness rule: SENT/VIEWED + code → reconcile). Fake provider now returns a real merged PDF + audit page (`omitAuditPage`).
- R8 2e65694 harness `assertDisposableDatabase` (_test/_scratch) in cleanTables/serializeSuite; golden terms hash `a10001dcd4e5aa60b7d3789632dce8dc15770bce695fb2f71c9e77137c0f47ab`
- R9 5fbbd16 (owner ruling R11) SignWell copy: custom_requester_name, optional ONBOARDING_REQUESTER_EMAIL, per-recipient subject/message, document name, reminders off; ops doc "Owner settings in SignWell"; `.env.example` un-ignored (`!.env.example`) and tracked with the name only.
- Final: DB_URL=…/iwd_onboarding_test full suite 47 suites / 449 tests passed (integration 8 suites / 93); `eslint src/onboarding` clean; `npm run lint` only the 3 pre-existing problems (src/logging.js, src/app.js). Container removed.
- F1 c3be76d signature v2 amendment 1: required `X-IW-Nonce` (/^[0-9a-f]{32}$/, else 401 `nonce_invalid`) as 7th canonical line. New vector (nonce 00112233445566778899aabbccddeeff) → `v2=fc02d0681f41e35df195d2c1c967c7b2e5e3f6d4e303419220e4725f84ba326f` (openssl cross-check); old vector void. Harness signs with a random nonce; timestamp stepping removed.
- F2 957b424 reconcile pass prunes `outreach:v2:*` receipts older than 24 h (raw DELETE … LIMIT 1000); provider receipts kept
- F3 ea5c58b recovery: PaymentSetup CREATING >10 min → FAILED `payment_setup_stale` (+ payment facet unless READY/PENDING_VERIFICATION) → `resend_payment_link` works
- Final after F1–F3: 47 suites / 454 tests passed (integration 8 / 98); eslint src/onboarding clean; npm run lint only the 3 pre-existing problems. Container removed.

## R14 — Iron Wing signs in Outreach (2026-11-18)

- R14.1 4918534 SignWell `embedded_signing: true` (create + send); recipients `send_email: true`, Iron Wing `send_email_delay` = `ONBOARDING_IRON_WING_EMAIL_DELAY_MINUTES` (0–60, default 60; OpenAPI Recipients.send_email_delay is minutes 0–60); fake provider: per-recipient `sign(id, recipientId)`, `embeddedSigningUrl`.
- R14.2 4b5845f `get()` returns recipients `[{id,status,signing_order}]`; pure `deriveWaitingFor` (signature/waitingFor.js; unknown statuses → null; signing-order fallback); migration `20261118140000_onboarding_signature_waiting_for` (nullable column + CHECK); set on send/webhook/reconcile, forced null outside SENT/VIEWED; status.v1 `signature.waiting_for` (zod optional+nullable).
- R14.3 98a36b1 `GET /onboarding/requests/:key/iron-wing-signing-url` → `{url, expires_hint:null}` / 409 `not_waiting_for_iron_wing` / 422 / 502 `signing_url_unavailable`; document_access_log `iron_wing_signing_url:<envelope>`; no-store; URL never logged (tested).
- R14.1b 178f695 decision: `embedded_signing_notifications` left at default false (owner notifications are off by owner choice; no CCs).
- R14.4 (docs commit) ops doc R14 section, config row, endpoint row, migration note, unverified list (recipient status values, recipient ids, delay semantics with 2 signers, carrier email under embedded mode, URL lifetime/new-tab, carrier completed copy).
- Final: 49 suites / 516 tests passed (integration 8 / 108); `eslint src/onboarding` clean; `npm run lint` only the 3 pre-existing problems. Container removed.
- Note for Outreach: the shared fixture `onboarding.status.v1.json` is unchanged here; if Outreach adds `waiting_for` to it, copy it byte-identically.

## R15 — signed copy + documents email, reminders, received/verified (2026-11-18)

- R15.1 e478825 combined completion email (signed PDF attached, sha256-checked; continue link; documents list; owner text verbatim) replaces the initial payment-link email; exactly-once claim `onboarding_request.completion_emailed_at` (failure releases, reconcile retries; crash between claim and send = not sent, never duplicated); recovery (a) sends it even when payment is already READY; resend keeps the plain link email; reply-to ONBOARDING_REQUESTER_EMAIL; emailService `attachments` additive (logo first). Migration `20261118160000_onboarding_completion_email` (+ backfill: requests whose payment email already went out are marked, never emailed retroactively). Access log `signed_packet_email:<envelope>` (actor `{system:"completion_email"}`). Full suite 51/531.
- R15.2 3726472 checklist RECEIVED (stored in the existing `operations` JSON; RECEIVED on a VERIFIED slot → 409 `item_already_verified`); actions `mark_operation_item_received`, `set_document_reminders` (audited, version bump); status.v1 item state RECEIVED + optional `operations.documents_requested_at|reminders_sent|reminders_paused` (zod); migration `20261118170000_onboarding_document_reminders`. Full suite 52/543.
- R15.3 b4d9e47 reminders: pure `addBusinessDays` (src/onboarding/businessDays.js; Mon–Fri NY, same wall-clock time, DST tested, no holidays); sweep in `reconcileOnce` only (candidates prefiltered by calendar days); claim = locked transition reminders_sent n-1→n (status event), failure gives it back; missing = carrier-facing slots still PENDING; payment line unless READY/PENDING_VERIFICATION. Full suite 53/570.
- R15.4 6f2ad41 `GET /onboarding/payment-saved` (public static plain text, no-store); ops doc R15 section, actions/endpoint rows, `ONBOARDING_STRIPE_SUCCESS_URL` = `<public>/onboarding/payment-saved`.
- R15 final: full suite 53 suites / 571 tests passed (baseline 517); `eslint src/onboarding src/emailService.js` clean; `npm run lint` only the pre-existing src/app.js + src/logging.js problems. Container removed.
- R15 decisions: item 3 without an MC number reads "A copy of your operating authority" (owner text assumes an MC); MC prefix stripped ("MC123456" → "MC 123456"); filename slug lower-case ASCII, max 80, fallback "carrier"; reminders also go when only the payment is missing (stop rule requires docs in AND payment saved); RECEIVED on a VERIFIED slot refused; reply-to also added to the resend payment-link email; crash between completion claim and SMTP = not sent (no stale-claim release), documented.
