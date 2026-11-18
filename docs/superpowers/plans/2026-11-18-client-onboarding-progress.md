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
