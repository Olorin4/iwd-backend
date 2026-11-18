# Client Onboarding Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private, mobile-friendly onboarding page per Iron Wing carrier at `onboarding.iron-wing-dispatching.com` (sign → payment → documents → optional questionnaire), with encrypted R2 document storage, an AI document reader that flags but never verifies, and the Outreach Sales panel showing and acting on all of it.

**Architecture:** iwd-backend gains a `src/onboarding/portal/` (server-rendered pages under `/p/<token>`, host-guarded), `src/onboarding/files/` (upload validation, R2 store, document versions), `src/onboarding/reader/` (Claude extraction + pure flag rules) and `src/onboarding/retention.js`, all behind `ONBOARDING_PORTAL_ENABLED`. Requests sent while the switch is on are marked `portal_flow = true` and use the new emails; in-flight requests finish on the R15 flow. Outreach consumes an additive `onboarding.status.v1` amendment plus new signed endpoints.

**Tech Stack:** iwd-backend: Node 22 ESM JavaScript, Express 4, Prisma 7, Zod 3.25, Jest 29, `@anthropic-ai/sdk` 1.10.x, `@aws-sdk/client-s3` 3.x, `busboy`, `heic-convert`. Outreach: TypeScript, Express, Prisma 6, React/Vite, Vitest, `@outreach/contracts`.

**Spec:** `docs/superpowers/specs/2026-11-18-client-onboarding-portal-design.md` (approved 2026-11-18). Background: `docs/operations/client-onboarding.md`; Outreach ledger `outreach/docs/superpowers/plans/2026-11-18-workflow-modernization-ledger.md` (R12–R18).

## Global Constraints

- The carrier hears only from Iron Wing: SignWell carrier recipient `send_email: false` in the portal flow; carrier emails = 1 invitation + ≤2 reminders (a re-upload email counts as a reminder).
- AI never verifies. Only staff actions set VERIFIED.
- Full W-9 TIN never stored outside the encrypted file: extracted data holds `tin_last4` only (`/^\d{4}$/`); any 9-digit TIN-like string in extracted output is dropped before storage.
- Portal tokens never appear in logs (iwd morgan/error logs, edge logs, Outreach logs).
- Uploads: PDF, JPEG, PNG, HEIC only, by magic bytes; ≤ 15 MB (15 × 1024 × 1024 bytes); stored AES-256-GCM-encrypted in a private R2 bucket; staff downloads only via Outreach, `Content-Disposition: attachment`, logged in `document_access_log`.
- Retention: request cancelled without READY → purge 90 days after `cancelled_at`; READY → purge 3 years after `ready_at`. Purge keeps a content-free record.
- Status contract changes are additive; old readers keep working; do NOT edit `docs/contracts/fixtures/onboarding.status.v1.json` (add a new fixture).
- Interim billing: no behaviour change; never import `src/interimBilling` from onboarding (architecture test).
- Every new iwd setting: server `.env` + GitHub secret + `.github/workflows/ci-cd-pipeline.yml` `.env` generation.
- Default model for the reader: `claude-opus-5-5` (setting `ONBOARDING_DOC_READER_MODEL`).
- Portal paths: pages/actions under `/p/<token>/…`, assets under `/portal-static/…` (fixed by the kelevoTMS edge vhost).
- Never send real carrier emails or SignWell live documents while testing; sandbox runs use test mode, owner addresses, ≤ 5 emails per run.

## Review Focus

1. **Forwarded or stale link** — a revoked token, a token for a purged request, or a token after READY + 30 days must show a plain "This link is no longer active — contact onboarding@iron-wing-dispatching.com" page (HTTP 410), never a stack trace or another carrier's data. → tests in Task 3 and Task 11.
2. **Upload disguised as PDF** — an HTML/SVG/EXE file renamed `.pdf`, or a 16 MB file, is refused with a plain message and nothing is stored. → Task 5 tests.
3. **Double submit / re-upload race** — two uploads to the same slot in quick succession end with exactly one current version, earlier ones `SUPERSEDED`, and the item RECEIVED once (one status event per upload, versions increase). → Task 7 test.
4. **Reader returns a full TIN or garbage** — the model puts a 9-digit number in any field, or output fails Zod: stored extraction must contain no 9-digit TIN pattern; a failed parse marks `extraction_status = FAILED` and the document stays RECEIVED. → Task 8 tests.
5. **Carrier opens step ① before Iron Wing signed or after completion** — before: "Iron Wing is preparing your agreement" (no SignWell call); after completion: a "Signed ✓" state with download, never a stale SignWell link. → Task 11 tests.

---

## File structure (iwd-backend unless noted)

| Path | Responsibility |
| --- | --- |
| `src/onboarding/config.js` (modify) | `portal`, `files`, `reader`, `retention` config blocks |
| `prisma/schema.prisma`, `prisma/migrations/20261119000000_onboarding_portal/` | new tables/columns |
| `src/onboarding/portal/token.js` | create/verify portal tokens (pure) |
| `src/onboarding/portal/tokens.js` | issue/revoke/resolve tokens in the DB |
| `src/onboarding/files/crypto.js` | shared AES-256-GCM "IWD1" seal/open (extracted from `documents/store.js`) |
| `src/onboarding/files/r2Store.js` | R2 DocumentStore adapter (put/get/delete) |
| `src/onboarding/files/validate.js` | magic-byte detection, size limit, HEIC→JPEG |
| `src/onboarding/files/documents.js` | record upload, versions, reject, read for staff |
| `src/onboarding/readiness.js`, `contracts.js` (modify) | REUPLOAD_REQUESTED state, unverify |
| `src/onboarding/reader/schemas.js` | Zod extraction schemas per document type |
| `src/onboarding/reader/flags.js` | pure flag rules |
| `src/onboarding/reader/claude.js` | Claude call (messages.parse) |
| `src/onboarding/reader/worker.js` | claim + run pending extractions |
| `src/onboarding/signature/signwell.js`, `signatureFlow.js` (modify) | carrier `send_email:false` in portal flow; carrier embedded URL |
| `src/onboarding/portalEmails.js` | invitation / reminder / re-upload texts |
| `src/onboarding/portalFlow.js` | invitation sending, portal reminders, flow switch helpers |
| `src/onboarding/portal/routes.js`, `portal/views.js`, `portal/csrf.js`, `portal/hostGuard.js` | portal HTTP |
| `src/onboarding/portal/static/portal.css`, `portal.js`, `logo.svg` | assets |
| `src/onboarding/questionnaire.js` | schema + save |
| `src/onboarding/staffRoutes.js` | signed staff endpoints (documents, file, upload) |
| `src/onboarding/retention.js` | purge job |
| `src/app.js`, `src/security.js` (modify) | mount portal, log redaction |
| Outreach `packages/contracts/src/sales.ts` | contract amendment + new types |
| Outreach `apps/api/src/modules/sales/infrastructure/iwd-onboarding.client.ts` | new client methods |
| Outreach `apps/api/src/modules/sales/http/onboarding.routes.ts`, `application/onboarding.ts` | proxies + actions |
| Outreach `apps/web/src/features/sales/OnboardingPanel.tsx` (+ new `OnboardingDocuments.tsx`) | panel UI |
| Outreach `apps/api/src/modules/sales/application/today.ts`, `apps/web/src/features/today/TodayPage.tsx` | "Documents to verify" card |

---

### Task 1: SignWell sandbox check — carrier embedded signing without email

Gate for the whole build (spec "SignWell assumptions"). Throwaway script, no product code.

**Files:**
- Create: `scratch/portal-signwell-check.mjs` (git-ignored; delete after)

- [ ] **Step 1:** Write a script reusing `createOnboardingDeps` like the R14 sandbox runner: test mode, a `_sandbox` DB, carrier recipient `nick.kalas@proton.me` with `send_email: false`, Iron Wing recipient `onboarding@iron-wing-dispatching.com` with the R14 settings, signing order Iron Wing → carrier.
- [ ] **Step 2:** Run it; sign as Iron Wing via its embedded URL; then GET the document and record: carrier recipient `status` values before/after Iron Wing signs, whether `embedded_signing_url` is present for the carrier, whether any email reached the carrier address (owner confirms inbox).
- [ ] **Step 3:** Expected: no carrier email; carrier embedded URL available once Iron Wing has signed. If the carrier still gets a SignWell email, **stop and report to the owner** before Task 9.
- [ ] **Step 4:** Record the observed statuses in `docs/operations/client-onboarding.md` § SignWell facts; delete the SignWell document; commit the doc change.

### Task 2: Settings and schema

**Files:**
- Modify: `src/onboarding/config.js`, `.env.example`, `.github/workflows/ci-cd-pipeline.yml`, `prisma/schema.prisma`
- Create: `prisma/migrations/20261119000000_onboarding_portal/migration.sql`
- Test: `__tests__/onboarding/config.test.js`

**Interfaces — Produces:** `getOnboardingConfig(env).portal = { enabled, baseUrl, tokenSecret, linkGraceDays: 30 }`, `.files = { r2: { accountId, bucket, accessKeyId, secretAccessKey }, encryptionKey: Buffer(32), maxBytes: 15728640 }`, `.reader = { enabled, model, apiKey }`, `.retention = { abandonedDays: 90, completedYears: 3 }`.

Settings: `ONBOARDING_PORTAL_ENABLED`, `ONBOARDING_PORTAL_BASE_URL` (https; production `https://onboarding.iron-wing-dispatching.com`), `ONBOARDING_PORTAL_TOKEN_SECRET` (≥32 chars), `ONBOARDING_R2_ACCOUNT_ID`, `ONBOARDING_R2_BUCKET`, `ONBOARDING_R2_ACCESS_KEY_ID`, `ONBOARDING_R2_SECRET_ACCESS_KEY`, `ONBOARDING_FILE_ENCRYPTION_KEY` (64 hex), `ONBOARDING_DOC_READER_ENABLED`, `ONBOARDING_DOC_READER_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_API_KEY`. When `portal.enabled` is true, all R2 + token + encryption settings are required (`OnboardingConfigError`); reader settings required only when reader enabled.

Schema (Prisma models, snake_case maps):
- `OnboardingRequest` + `portal_flow Boolean @default(false)`, `portal_invited_at DateTime?`, `portal_invite_claimed_at DateTime?`, `portal_invite_attempts Int @default(0)`, `portal_last_opened_at DateTime?`, `ready_at DateTime?`, `purge_after DateTime?`, `purged_at DateTime?`.
- `PortalToken` (`portal_token`): `id String @id` (random 22-char base64url), `request_id`, `created_at`, `revoked_at DateTime?`, index on request_id.
- `OnboardingDocument` (`onboarding_document`): `id uuid`, `request_id`, `item_key String`, `version Int`, `source String` (CARRIER|STAFF), `uploaded_by Json?`, `storage_key String?`, `sha256`, `size Int`, `media_type String`, `state String` (CURRENT|SUPERSEDED|REJECTED), `reject_reason String?`, `extraction_status String` (PENDING|DONE|FAILED|DISABLED), `extraction_attempts Int @default(0)`, `extraction_claimed_at DateTime?`, `extracted Json?`, `flags Json?`, `created_at`, `purged_at DateTime?`; `@@unique([request_id, item_key, version])`.
- `OnboardingQuestionnaire` (`onboarding_questionnaire`): `request_id @unique`, `answers Json`, `submitted_at`, `updated_at`.

- [ ] **Step 1:** Write failing tests in `config.test.js`: `portal disabled needs no portal settings`; `portal enabled without ONBOARDING_R2_BUCKET throws OnboardingConfigError naming it`; `ONBOARDING_FILE_ENCRYPTION_KEY must be 64 hex`; `reader model defaults to claude-opus-5-5`; `retention defaults are 90 days and 3 years`.
- [ ] **Step 2:** Run `npm test -- __tests__/onboarding/config.test.js` → FAIL.
- [ ] **Step 3:** Implement the config blocks; add the Prisma models/columns and write the migration (`npx prisma migrate dev --create-only --name onboarding_portal` against the local test DB, then review SQL).
- [ ] **Step 4:** Add the 11 keys to `.env.example` (empty values) and 11 `echo "KEY=${{ secrets.KEY }}" >> .env` lines to the pipeline after the onboarding block.
- [ ] **Step 5:** `npm test` → PASS; `npx prisma validate` → OK.
- [ ] **Step 6:** Commit `feat(onboarding): portal settings and schema`.

### Task 3: Portal tokens

**Files:**
- Create: `src/onboarding/portal/token.js`, `src/onboarding/portal/tokens.js`
- Test: `__tests__/onboarding/portalToken.test.js`, `__tests__/onboarding/portalTokens.integration.test.js`

**Interfaces — Produces:**
- `createPortalToken(secret, tokenId) → string` (`<tokenId>.<hex hmac-sha256(secret, "portal:"+tokenId)>`); `parsePortalToken(secret, token) → { tokenId } | { error: "invalid" }` (length ≤ 120, constant-time compare via `safeEqualHex`).
- `issuePortalToken(db, requestId, { revokeExisting }) → { tokenId, url }`; `resolvePortalToken(deps, token) → { row } | { error: "invalid" | "inactive" }` where inactive = revoked, request purged, or (`ready_at` or `cancelled_at`) older than `portal.linkGraceDays`; `portalUrl(config, tokenId)`.

- [ ] **Step 1:** Unit tests: round trip; tampered mac → invalid; extra dot segment → invalid; 500-char token → invalid.
- [ ] **Step 2:** Integration tests: `revoked token is inactive`; `issue with revokeExisting revokes the previous token`; `token for request READY 31 days ago is inactive, 29 days ago active`; `token for purged request is inactive`.
- [ ] **Step 3:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 4:** Commit `feat(onboarding): portal access tokens`.

### Task 4: Encrypted R2 file store

**Files:**
- Create: `src/onboarding/files/crypto.js`, `src/onboarding/files/r2Store.js`
- Modify: `src/onboarding/documents/store.js` (use `crypto.js`; behaviour unchanged)
- Test: `__tests__/onboarding/r2Store.test.js`; existing `documents.test.js` must stay green.

**Interfaces — Produces:** `seal(key, storageKey, plaintext) → Buffer`, `open(key, storageKey, blob) → Buffer` (IWD1 format, storage key as AAD, throws `DocumentStoreError("integrity_failed")`); `createR2DocumentStore({ client, bucket, key }) → { put(bytes, { prefix }) → { storage_key, sha256, size }, get(storage_key, { expectedSha256 }) → Buffer, delete(storage_key) → void }`. Storage keys: `docs/<uuid>.bin` (no personal data). `client` is an injected `S3Client` (endpoint `https://<accountId>.r2.cloudflarestorage.com`, region `auto`).

- [ ] **Step 1:** Tests with a fake S3 client (in-memory map, `send(command)` switch on command class): `put then get returns plaintext`; `stored object is not the plaintext and starts with IWD1`; `get with wrong expectedSha256 throws integrity_failed`; `blob copied under another key fails to open`; `delete removes the object`.
- [ ] **Step 2:** Run → FAIL. Implement (add `@aws-sdk/client-s3` dependency). Run all onboarding tests → PASS.
- [ ] **Step 3:** Commit `feat(onboarding): encrypted R2 document store`.

### Task 5: Upload validation

**Files:**
- Create: `src/onboarding/files/validate.js`
- Test: `__tests__/onboarding/uploadValidate.test.js` (fixtures in `__tests__/onboarding/fixtures/uploads/`: tiny PDF, JPEG, PNG, HEIC, an HTML file named `.pdf`, an SVG)

**Interfaces — Produces:** `validateUpload(bytes, { maxBytes }) → Promise<{ ok: true, bytes, mediaType: "application/pdf"|"image/jpeg"|"image/png" } | { ok: false, code: "too_large"|"unsupported_type"|"empty" }>`. HEIC (`ftypheic|ftypheix|ftypmif1`) is converted to JPEG with `heic-convert` (quality 0.9) and reported as `image/jpeg`. Detection by leading bytes only: `%PDF-`, `FF D8 FF`, `89 50 4E 47 0D 0A 1A 0A`.

- [ ] **Step 1:** Tests: each accepted type; `HTML renamed .pdf → unsupported_type`; `SVG → unsupported_type`; `15 MB + 1 byte → too_large`; `0 bytes → empty`; `HEIC → image/jpeg`.
- [ ] **Step 2:** Run → FAIL. Implement (add `heic-convert`). Run → PASS.
- [ ] **Step 3:** Commit `feat(onboarding): upload type and size validation`.

### Task 6: Checklist states — re-upload and undo verify

**Files:**
- Modify: `src/onboarding/readiness.js`, `src/onboarding/contracts.js`, `src/onboarding/actions.js`
- Test: `__tests__/onboarding/readiness.test.js`, `__tests__/onboarding/lifecycle.integration.test.js`

**Interfaces — Produces:** `OPERATION_ITEM_STATES = ["PENDING","RECEIVED","VERIFIED","REUPLOAD_REQUESTED"]`; `requestReupload(items, key, { actor, note, at }) → items` (from RECEIVED or VERIFIED; note = reason, required, ≤300 chars); `unverifyOperationItem(items, key, { actor, at }) → items | null` (VERIFIED → RECEIVED; null otherwise); `missingCarrierSlots` counts PENDING **and** REUPLOAD_REQUESTED as missing. New actions: `request_reupload { key, reason }`, `unverify_operation_item { key }` (audited, version bump + status event). `markOperationItemReceived` moves REUPLOAD_REQUESTED → RECEIVED.

- [ ] **Step 1:** Unit tests: `request reupload from RECEIVED sets REUPLOAD_REQUESTED with note`; `request reupload without reason throws`; `unverify VERIFIED → RECEIVED`; `unverify PENDING → null`; `missingCarrierSlots includes a REUPLOAD_REQUESTED W9`; `operationsState stays PENDING while any item is REUPLOAD_REQUESTED`.
- [ ] **Step 2:** Integration: `request_reupload action bumps version and writes status event`.
- [ ] **Step 3:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 4:** Commit `feat(onboarding): re-upload requests and undo verify`.

### Task 7: Document versions service

**Files:**
- Create: `src/onboarding/files/documents.js`
- Modify: `src/onboarding/deps.js` (add `fileStore`), `src/onboarding/actions.js` (`request_reupload` also marks the current document REJECTED with the reason)
- Test: `__tests__/onboarding/portalDocuments.integration.test.js`

**Interfaces — Consumes:** Task 4 store, Task 5 `validateUpload`, Task 6 states. **Produces:**
- `UPLOADABLE_KEYS = ["W9","INSURANCE_COI","AUTHORITY_VERIFIED","FACTORING_NOA"]`.
- `recordUpload(deps, requestId, itemKey, bytes, { source: "CARRIER"|"STAFF", actor }) → { ok: true, documentId, version } | { ok: false, code }` — validates, stores, inside one transaction with `lockRequest`: previous CURRENT → SUPERSEDED, insert version n+1 CURRENT with `extraction_status` = `PENDING` (reader enabled) or `DISABLED`, mark item RECEIVED (refused with `already_verified` when the slot is VERIFIED), status event. STAFF uploads refused with `document_present` when the slot already has a CURRENT document and the item is not REUPLOAD_REQUESTED.
- `markNotFactoring(deps, requestId)` → item NOT_FACTORING RECEIVED (no file).
- `listDocuments(db, requestId) → [{ id, item_key, version, source, state, media_type, size, created_at, extraction_status, extracted, flags, reject_reason }]` (CURRENT + REJECTED, newest first).
- `readDocumentFile(deps, requestId, documentId, actor) → { bytes, mediaType, filename }` — writes `document_access_log` with `document = "upload:<documentId>"`.

- [ ] **Step 1:** Integration tests: `upload marks W9 RECEIVED and stores version 1`; `second upload supersedes the first (Review Focus 3: two concurrent recordUpload calls → versions 1 and 2, exactly one CURRENT)`; `upload to VERIFIED slot refused`; `HTML upload stores nothing (no R2 put, no row)`; `staff upload refused when a CURRENT document exists`; `staff upload allowed after request_reupload`; `readDocumentFile logs access`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(onboarding): document versions and staff file access`.

### Task 8: AI document reader

**Files:**
- Create: `src/onboarding/reader/schemas.js`, `reader/flags.js`, `reader/claude.js`, `reader/worker.js`
- Modify: `src/onboarding/workers.js` (run `readPendingDocuments` each tick when reader enabled)
- Test: `__tests__/onboarding/readerFlags.test.js`, `__tests__/onboarding/readerSchemas.test.js`, `__tests__/onboarding/readerWorker.integration.test.js`

**Interfaces — Produces:**
- Zod schemas (all fields nullable when unreadable), plus `document_type_matches: boolean` on each:
  - `w9Schema { legal_name, business_name, entity_type, tin_type: "SSN"|"EIN"|null, tin_last4: /^\d{4}$/|null, address, signature_present: boolean, signature_date: "YYYY-MM-DD"|null }`
  - `coiSchema { insurers: string[], policies: [{ coverage: "AUTO_LIABILITY"|"CARGO"|"GENERAL_LIABILITY"|"OTHER", policy_number, limit_usd: number|null, effective_date, expiry_date }], certificate_holder, named_insured }`
  - `authoritySchema { mc_number, usdot, legal_name, authority_type, granted_date }`
  - `noaSchema { factoring_company, remittance_address, contact_email, contact_phone, effective_date, carrier_name }`
- `stripTinLike(extracted) → extracted` — replaces any string value matching `/\b\d{3}-?\d{2}-?\d{4}\b|\b\d{2}-?\d{7}\b/` with `null`.
- `computeFlags(itemKey, extracted, terms, today) → string[]` with codes: `wrong_document_type`, `name_mismatch` (normalized legal name ≠ `terms.legal_name`; normalization: uppercase, strip punctuation and `LLC|L.L.C.|INC|CORP|CO` suffixes), `mc_mismatch`, `usdot_mismatch`, `insurance_expired`, `insurance_expiring_30d`, `signature_missing`, `unreadable`.
- `extractDocument({ client, model }, itemKey, { bytes, mediaType }) → parsed` — `client.messages.parse({ model, max_tokens: 4000, output_config: { format: zodOutputFormat(schema) }, messages: [{ role: "user", content: [<document|image block, base64>, { type: "text", text: PROMPT[itemKey] }] }] })`; PDF as `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`, images as `{ type: "image", … }`. Check `stop_reason === "refusal"` → throw `reader_refused`; `parsed_output === null` → throw `reader_unparsed`. Prompt says: extract only what is printed; for the W-9 give only the last four digits of the TIN, never the full number. Verify `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` works with the repo's zod 3.25; if not, import schemas from `zod/v4`.
- `readPendingDocuments(deps) → { done, failed }` — claims up to 5 PENDING docs (claim CAS, stale 15 min), max 3 attempts → FAILED; on success stores `stripTinLike(extracted)` + flags, `extraction_status = DONE`, writes a status event. Never logs document content or model output.

- [ ] **Step 1:** Flag tests: `name_mismatch ignores L.L.C. vs LLC and punctuation`; `insurance_expiring_30d at 20 days`; `insurance_expired`; `wrong_document_type when document_type_matches=false`.
- [ ] **Step 2:** Schema/strip tests: `stripTinLike removes 123-45-6789 and 12-3456789 from any field` (Review Focus 4); `tin_last4 "123456789" fails w9Schema`.
- [ ] **Step 3:** Worker integration with a fake `extractDocument`: `success stores extraction, flags and DONE`; `unparsed output after 3 attempts → FAILED, item still RECEIVED`; `model output containing a full TIN is stored without it`.
- [ ] **Step 4:** Run → FAIL. Implement (add `@anthropic-ai/sdk@^1.10.0`). Run → PASS.
- [ ] **Step 5:** Commit `feat(onboarding): AI document reader (flags only)`.

### Task 9: Carrier embedded signing in the portal flow

**Files:**
- Modify: `src/onboarding/signature/signwell.js`, `src/onboarding/signatureFlow.js`, `src/onboarding/actions.js`
- Test: `__tests__/onboarding/signwell.test.js`, `__tests__/onboarding/signature.integration.test.js`

**Interfaces — Produces:** `signwellRecipient(signer)` honours `signer.sendEmail === false` → `send_email: false`. `sendPacket` sets `portal_flow = config.portal.enabled` on the request at first send (unchanged on reissue) and, when true, builds the carrier signer with `sendEmail: false` and no `redirect_url` change beyond pointing it to the portal URL. `carrierSigningUrl(deps, requestId) → { url } | { error: "not_waiting_for_carrier" | "completed" }` — re-fetches the document; only while `waiting_for === "CARRIER"`; URL never logged.

- [ ] **Step 1:** Tests: `carrier recipient has send_email false in portal flow`; `legacy flow unchanged (send_email true)`; `carrierSigningUrl refuses while waiting for IRON_WING`; `reissue keeps portal_flow`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(onboarding): carrier signs on the portal`.

### Task 10: Portal emails and flow switch

**Files:**
- Create: `src/onboarding/portalEmails.js`, `src/onboarding/portalFlow.js`
- Modify: `src/onboarding/documentsFlow.js` (skip completion email + R15 reminders when `portal_flow`), `src/onboarding/signatureFlow.js` / `recovery.js` (call `sendPortalInvitation` when `waiting_for` becomes CARRIER), `src/onboarding/paymentFlow.js` (portal-flow Stripe success/cancel URLs = `<portal url>?payment=saved|cancelled`), `src/onboarding/workers.js`
- Test: `__tests__/onboarding/portalEmails.test.js`, `__tests__/onboarding/portalFlow.integration.test.js`

**Interfaces — Produces:** `invitationEmail({ terms, url })`, `portalReminderEmail({ terms, url, missing })`, `reuploadEmail({ terms, url, itemLabel, reason })` → `{ subject, text, html }` (plain-text-equivalent HTML with one button, like the R16 payment button). `sendPortalInvitation(deps, requestId)` (claim pattern as `sendCompletionEmail`: stale 30 min, 3 attempts, issues a fresh token revoking older ones). `sendDuePortalReminder(deps, requestId)` (R15 schedule: 3 and 7 business days after `portal_invited_at`, America/New_York; only while signature not COMPLETED, payment not READY/PENDING_VERIFICATION, or a carrier-facing **document** item missing — CARRIER_PROFILE is satisfied by the closer and is never listed to the carrier (`PORTAL_CARRIER_SLOTS = ["W9","INSURANCE_COI","AUTHORITY_VERIFIED","FACTORING"]`); stops on cancel/pause). `request_reupload` on a portal request sends `reuploadEmail` and increments `reminders_sent` (no email when `reminders_sent` is already 2 — the page still shows the reason).

Draft texts (owner approval gate before release; tests assert these exact strings):
- Invitation — Subject `Your Iron Wing onboarding page — {Legal name}`; body: `Hello {signer name},` / `Iron Wing Logistics L.L.C. has signed your dispatch service agreement. Your private onboarding page is ready:` / `{button: Open your onboarding page}` / `{url on its own line}` / `On the page you can sign the agreement, save your payment method on Stripe's secure page, and upload your W-9, certificate of insurance, operating authority and factoring notice. Nothing is charged when you save a payment method. Please don't forward this link; it is private to {Legal name}.`
- Reminder — Subject `Reminder: your Iron Wing onboarding — {Legal name}`; body lists the open steps (`Sign your agreement`, `Save your payment method`, document labels) and the page link.
- Re-upload — Subject `Please upload a new {item label} — {Legal name}`; body: the reason and the page link.

- [ ] **Step 1:** Email tests: exact subjects; link on its own line; no `{`/`}` in text; no SignWell or Stripe URLs in the invitation.
- [ ] **Step 2:** Flow tests: `reminder never lists the carrier profile`; `waiting_for CARRIER on a portal request sends exactly one invitation (idempotent across reconcile)`; `portal request gets no completion email at signature COMPLETED`; `legacy request still gets the R15 completion email`; `reminder 2 is not sent after a re-upload email used the budget`; `cancel stops reminders`.
- [ ] **Step 3:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 4:** Commit `feat(onboarding): portal invitation, reminders and re-upload email`.

### Task 11: Portal pages and actions

**Files:**
- Create: `src/onboarding/portal/routes.js`, `portal/views.js`, `portal/csrf.js`, `portal/hostGuard.js`, `portal/static/portal.css`, `portal/static/portal.js`, `portal/static/logo.svg`, `src/onboarding/questionnaire.js`
- Modify: `src/app.js` (mount `createPortalRouter` at `/` before the API routers; serve `/portal-static` from `portal/static` with `immutable` cache), `src/security.js` (morgan `skip` also skips any `/p/` path; error handler logs `req.path.replace(/^\/p\/[^/]+/, "/p/[token]")`)
- Test: `__tests__/onboarding/portalRoutes.integration.test.js`, `__tests__/onboarding/portalViews.test.js`, `__tests__/onboarding/questionnaire.test.js`

**Interfaces — Consumes:** Tasks 3, 7, 9, 10. **Produces:** routes (all `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, CSP `default-src 'self'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'`):
- `GET /p/:token` page; updates `portal_last_opened_at` (at most once per 5 min).
- `GET /p/:token/sign` → 303 to `carrierSigningUrl`; before Iron Wing signed or after completion → page with state message (Review Focus 5).
- `GET /p/:token/payment` → reuse `handleContinue` logic to 303 to Stripe; 409 page before signature COMPLETED.
- `GET /p/:token/agreement` → completed signed PDF (attachment), logged as `actor: { type: "carrier" }`.
- `POST /p/:token/documents/:itemKey` (multipart, `busboy`, single file field `file`, limit `maxBytes + 1`) → 303 back with `?uploaded=<key>` or `?error=<code>`; `POST /p/:token/not-factoring`.
- `GET|POST /p/:token/questionnaire` (optional; fields: `equipment_types[]` (Dry van, Reefer, Flatbed, Step deck, Power only, Box truck, Hotshot, Other), `truck_count` int 1–500, `home_base` text, `preferred_lanes` text ≤1000, `min_rate_per_mile` number|null, `min_rate_per_load` number|null, `excluded_freight` text ≤500, `max_deadhead_miles` int|null, `availability` text ≤300, `other_preferences` text ≤2000).
- `GET /p/:token/status.json` → `{ signature, payment, items: [{ key, state }] }` for polling after signing/payment (no personal data).
- `hostGuard(config)`: on the portal host only `/p/` and `/portal-static/` are served (else 404); on other hosts `/p/` returns 404.
- CSRF: every POST requires `Origin` equal to `portal.baseUrl` origin **and** hidden field `csrf` = hex HMAC(tokenSecret, "csrf:"+tokenId) (`portal/csrf.js`).
- Inactive/invalid token → 410 page with the contact address (Review Focus 1). Errors render a generic page; no internal codes beyond the upload codes.
- Views: escaped templates (`escapeHtml` for every interpolated value), steps ①–④ per the spec sketch, item labels: W-9 form, Certificate of insurance, Operating authority (MC {mc}), Factoring notice of assignment / "I don't use factoring"; REUPLOAD_REQUESTED shows the reason; VERIFIED shows "Verified ✓"; the page JS polls `status.json` every 5 s for 2 min after returning from SignWell/Stripe.

- [ ] **Step 1:** Route tests (supertest, Host header `onboarding.iron-wing-dispatching.com`): `page renders legal name and steps`; `invalid token → 410`; `revoked token → 410`; `API path on portal host → 404`; `/p/ on api host → 404`; `POST without Origin → 403`; `POST with wrong csrf → 403`; `upload HTML file → redirect with error=unsupported_type and nothing stored`; `sign before Iron Wing signed shows preparing message without SignWell call`; `sign after completion shows signed state`; `payment before signature → 409 page`; `token never appears in any logger call (spy on logger + morgan stream)`.
- [ ] **Step 2:** View tests: `legal name with <script> is escaped`; `REUPLOAD_REQUESTED shows the reason`.
- [ ] **Step 3:** Questionnaire tests: valid save; `truck_count 0 rejected`; optional fields may be empty.
- [ ] **Step 4:** Run → FAIL. Implement (add `busboy`). Run → PASS.
- [ ] **Step 5:** Manual check: `npm run dev` with a seeded sandbox request; open the page at 390 px and 1280 px wide in Playwright; screenshot both for the owner.
- [ ] **Step 6:** Commit `feat(onboarding): carrier onboarding portal pages`.

### Task 12: Status contract amendment and staff endpoints (iwd)

**Files:**
- Modify: `src/onboarding/readiness.js` (`buildStatus`), `src/onboarding/routes.js` (mount staff routes)
- Create: `src/onboarding/staffRoutes.js`, `docs/contracts/fixtures/onboarding.status.v1.portal.json` (iwd copy; Outreach gets the same file in Task 15)
- Test: `__tests__/onboarding/contracts.test.js`, `__tests__/onboarding/staffRoutes.integration.test.js`

**Interfaces — Produces:**
- Status additions (all optional): `operations.items[].state` may be `REUPLOAD_REQUESTED`; `operations.items[].document = { version, source, extraction: "PENDING"|"DONE"|"FAILED"|"DISABLED", flags: string[] } | null`; `portal = { flow: boolean, invited_at, last_opened_at, questionnaire_submitted: boolean } | null`.
- Signed (v2, actor required) endpoints: `GET /onboarding/requests/:key/documents` → `{ documents: listDocuments(...), questionnaire: answers|null }`; `GET /onboarding/requests/:key/documents/:documentId/file` → stream, attachment, `no-store`, logged; `POST /onboarding/requests/:key/documents/:itemKey` → staff upload (raw body = file bytes, `Content-Type` = media type, ≤ 15 MB; signature covers the body hash) → `recordUpload(..., { source: "STAFF" })`; action `resend_portal_link` → new token + invitation email (counts as invitation, not a reminder; closer/owner).

- [ ] **Step 1:** Contract test: status for a portal request validates; the original fixture still validates (old reader unchanged).
- [ ] **Step 2:** Endpoint tests: unsigned → 401; file download logs access and sets attachment; staff upload when document present → 409 `document_present`; resend revokes the old token.
- [ ] **Step 3:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 4:** Commit `feat(onboarding): staff document endpoints and status amendment`.

### Task 13: Retention purge

**Files:**
- Create: `src/onboarding/retention.js`
- Modify: `src/onboarding/store.js` or readiness transition (set `ready_at` when readiness first becomes READY; set `purge_after = ready_at + 3 years`; on cancel without READY set `purge_after = cancelled_at + 90 days`), `src/onboarding/workers.js` (run `purgeDue` once per day, 03:00 America/New_York)
- Test: `__tests__/onboarding/retention.integration.test.js`

**Interfaces — Produces:** `purgeDue(deps, now) → { purged }` — for each request with `purge_after <= now` and `purged_at` null: delete R2 objects of all its documents, null `extracted`, `flags`, `storage_key` and set `purged_at` on each document, delete the questionnaire, delete the stored completed signed PDF (and filled PDF) from the document store and null their keys, revoke tokens, set request `purged_at`, write audit event `onboarding.purged` with counts only. Keeps document rows (type, dates, sha256, source, uploaded_by, verified actor).

- [ ] **Step 1:** Tests: `cancelled request purged after 90 days, not at 89`; `READY request purged after 3 years`; `purge removes R2 objects and extracted data but keeps rows with sha256`; `portal token for purged request is inactive`; `purge is idempotent`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3:** Commit `feat(onboarding): retention purge`.

### Task 14: Outreach — contract amendment and iwd client

**Repo:** `/home/olorin4/web-dev/outreach`

**Files:**
- Modify: `packages/contracts/src/sales.ts`, `apps/api/src/modules/sales/infrastructure/iwd-onboarding.client.ts`
- Create: `docs/contracts/fixtures/onboarding.status.v1.portal.json` (same bytes as iwd's)
- Test: `apps/api/src/modules/sales/onboarding-contract.test.ts`, `apps/api/src/modules/sales/infrastructure/iwd-onboarding.client.test.ts`

**Interfaces — Produces:** `OPERATIONS_ITEM_STATES` adds `"REUPLOAD_REQUESTED"`; `carrierDocumentsOutstanding` treats it as outstanding; schema fields from Task 12 with `.optional().default(null)`; types `OnboardingDocument`, `OnboardingDocumentsResponse`, `OnboardingQuestionnaire`. Client methods: `documents(key, actor) → IwdResult<OnboardingDocumentsResponse>`, `documentFile(key, documentId, actor) → IwdDocumentResult` (stream like `signedDocument`), `uploadDocument(key, itemKey, bytes, mediaType, actor)`; actions `request_reupload`, `unverify_operation_item`, `resend_portal_link` via the existing action call.

- [ ] **Step 1:** Tests: portal fixture parses; old fixture parses with `portal: null`; `carrierDocumentsOutstanding` true for REUPLOAD_REQUESTED; client signs the upload with the body hash of the file bytes (vector check against `signIwRequestV2`).
- [ ] **Step 2:** `npm test -w @outreach/contracts && npm test -w api -- onboarding` → FAIL. Implement. → PASS.
- [ ] **Step 3:** Commit `feat(sales): portal fields in the onboarding contract and iwd client`.

### Task 15: Outreach — API routes and actions

**Files:**
- Modify: `apps/api/src/modules/sales/http/onboarding.routes.ts`, `apps/api/src/modules/sales/application/onboarding.ts`, opportunity "mark lost" path in `apps/api/src/modules/sales/application/` (where LOST is set)
- Test: `apps/api/src/modules/sales/onboarding.integration.test.ts`

**Interfaces — Produces:** routes (brand-scoped, closer = OWNER or `can_close_sales`, audited, `no-store`):
`GET /api/sales/onboarding/:requestId/documents`; `GET /api/sales/onboarding/:requestId/documents/:documentId/file` (stream; never logged body); `POST /api/sales/onboarding/:requestId/documents/:itemKey` (raw body ≤ 15 MB, `express.raw({ type: ["application/pdf","image/jpeg","image/png","image/heic"], limit: "15mb" })`); actions `request_reupload` (body `{ key, reason }`), `unverify_operation_item`, `resend_portal_link` through the existing actions endpoint. Marking an opportunity LOST while its onboarding request is live sends `cancel` to iwd (so retention starts).

- [ ] **Step 1:** Integration tests: non-closer → 403 on each route; cross-brand request → 404; reason missing → 400; mark lost sends exactly one cancel.
- [ ] **Step 2:** `OUTREACH_INTEGRATION=1 npm test -w api -- onboarding.integration` → FAIL. Implement. → PASS.
- [ ] **Step 3:** Commit `feat(sales): onboarding document routes and actions`.

### Task 16: Outreach — onboarding panel and Today card

**Files:**
- Create: `apps/web/src/features/sales/OnboardingDocuments.tsx`, `OnboardingDocuments.test.tsx`
- Modify: `apps/web/src/features/sales/OnboardingPanel.tsx`, `apps/web/src/features/sales/api.ts`, `apps/api/src/modules/sales/application/today.ts`, `apps/web/src/features/today/TodayPage.tsx`, `TodayPage.test.tsx`

**Interfaces — Produces:** per item row: state label (`Needed`, `Received — to verify`, `Verified`, `New upload requested: {reason}`), upload time and source ("from carrier"/"uploaded by {name}"), extraction values (field: value list; "Reading…" while PENDING; "Couldn't read — check manually" when FAILED), flags as warning chips with plain text (`name_mismatch` → "Name differs from the agreement", `insurance_expiring_30d` → "Insurance expires within 30 days", etc.), buttons **View file**, **Verify**, **Ask for a new upload** (dialog with reason), **Undo verify**, **Upload** (only when no CURRENT document or REUPLOAD_REQUESTED). Panel header: "Portal link sent {date} · last opened {date|never}", **Send the link again**; questionnaire answers block. Today card **Documents to verify**: count of live requests with any item RECEIVED, linking like the other onboarding cards.

- [ ] **Step 1:** Component tests: upload button hidden when a CURRENT document exists, shown after re-upload request; flags render as text; reason dialog requires text; Today card count.
- [ ] **Step 2:** `npm test -w web -- OnboardingDocuments TodayPage` → FAIL. Implement. → PASS. `npm run typecheck && npm run lint`.
- [ ] **Step 3:** Commit `feat(sales): documents, flags and portal link in the onboarding panel`.

### Task 17: Sandbox acceptance

**Files:**
- Create: `docs/operations/onboarding-portal-acceptance.md`

- [ ] **Step 1:** In the sandbox stack (test DB `_sandbox`, SignWell test mode, Stripe test keys, a test R2 bucket `iwd-onboarding-docs-test`, reader enabled), run one request end to end with owner addresses (≤ 5 emails): Send packet → sign as Iron Wing → invitation arrives (only email to carrier) → portal sign → Stripe test card → upload a sample W-9 (fake TIN), COI, authority, "I don't use factoring" → reader results and flags in Outreach → request re-upload (email) → staff upload → verify all → READY.
- [ ] **Step 2:** Run the iwd harness and Outreach suites: `npm test` (iwd), `npm test` + `OUTREACH_INTEGRATION=1 npm test -w api` (Outreach). All green.
- [ ] **Step 3:** Record results and screenshots in the acceptance doc; owner approves the email texts and page look. Commit.

### Task 18: Release (owner-gated)

- [ ] **Step 1:** Owner creates the R2 bucket `iwd-onboarding-docs` (private, no public access) and an API token scoped to it; owner or Claude (with approval) adds DNS `onboarding` CNAME (proxied) in the iron-wing zone.
- [ ] **Step 2:** Add the Task 2 settings to the server `.env`, GitHub secrets and pipeline (already in the workflow); `ONBOARDING_PORTAL_ENABLED=false` at first.
- [ ] **Step 3:** Deploy iwd-backend and Outreach (manual SSH per `outreach-production-deploy` notes; DB backup first; `prisma migrate deploy` runs in the container); rsync `onboarding.iron-wing.conf` to `~/infra/edge/conf.d/`, `docker exec edge-nginx nginx -t && nginx -s reload`; check `curl -s -o /dev/null -w "%{http_code}" https://onboarding.iron-wing-dispatching.com/` → 404 and a bogus `/p/x` → 410.
- [ ] **Step 4:** Owner turns on `ONBOARDING_PORTAL_ENABLED=true`; restart iwd-backend; next Send packet uses the portal flow. Update the ledger and `docs/operations/client-onboarding.md`.
