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
- amend (next commit) contract amendment for `terms` (FLEET replaces CUSTOM; fleet_service_plan, truck_count, primary_payment_method, statement_email; fixture re-copied byte-identical); layout format switched to the reviewed draft format (top-left PDF points; stamp/stamp_check/signwell); reviewed DRAFT layout copied to `docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.draft.json` (status stays DRAFT); filler fails closed with `field_overflow` (never below 7 pt, never clipped); SignWell boxes go through one calibration function (identity, top-left; `ONBOARDING_SIGNWELL_COORD_SCALE/_OFFSET_X/_OFFSET_Y`) and log `signwell_coordinates_uncalibrated` until `ONBOARDING_SIGNWELL_COORDS_CALIBRATED=1`; `ONBOARDING_COUNTERSIGNER_TITLE` added; bundle CLI `--expect-sha256` for the release copy (v1 sha256 98922710…43aa, 6 pages) and layout `sha256` must match the PDF.
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
