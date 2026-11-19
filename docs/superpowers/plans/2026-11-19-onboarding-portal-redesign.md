# Onboarding Portal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the carrier portal as the owner-approved gold timeline with A-style upload rows, add multi-photo → one PDF uploads, make factoring optional for portal onboardings, and show load board access per board (waiting vs confirmed) in the portal and Outreach.

**Architecture:** iwd-backend keeps server-rendered portal pages; a pure `portalSteps(row)` decides each step's done/current/upcoming state and the views render a `<details>` timeline from it. Uploads gain a pre-step that turns 1–10 images into one PDF before the existing `recordUpload`. Readiness rules take the request's flow into account (`portal_flow`). Outreach's contract helper and panel follow.

**Tech Stack:** Node 22 ESM, Express 4, busboy, sharp, pdf-lib, heic-convert, Prisma 7, Jest (iwd); TypeScript, React, Vitest, Zod (Outreach).

**Spec:** `docs/superpowers/specs/2026-11-19-onboarding-portal-redesign-design.md` (approved 2026-11-19). Mockups: https://claude.ai/artifact/82iiKdcyAZV6Uqv7y2yiWu (row "Chosen").

## Global Constraints

- Theme: navy `#0b2440` / `#08347c`, ink `#080d17`, hero `linear-gradient(172deg, rgb(0,98,139) 0%, #0b2440 100%)`, gold button `linear-gradient(172deg, rgb(255,200,0), rgb(238,228,141))` + `3px outset #080d17`, Arial, card radius 12px; portal keeps its own header (logo + "Iron Wing Logistics L.L.C.") and one-line footer.
- Required steps counted in the header: sign, payment, documents, load board (4). Step 5 questionnaire is optional, never counted.
- Factoring optional **only when `portal_flow`**; email-flow rules and R15 texts unchanged.
- Multi-photo: ≤10 files per document post; PDF alone or images only (`mixed_files`); total ≤15 MB before and combined PDF ≤15 MB after (`too_large`); >10 → `too_many_pages`.
- "Take photos" visible only under `@media (hover: none) and (pointer: coarse)`.
- Page works without JavaScript; touch targets ≥44px; contrast ≥4.5:1.
- Approved email texts unchanged. Release: Outreach before/with iwd. Never push iwd `master` without the owner's go (push deploys).
- Shared fixture `docs/contracts/fixtures/onboarding.status.v1.portal.json` byte-identical in both repos.

## Review Focus

1. **Carrier presses "Added" for a board staff already confirmed** — stays confirmed, no duplicate entry, step stays done. → Task 2 test.
2. **A huge phone photo (e.g. 6000×8000 PNG) in a multi-photo set** — combined PDF stays ≤15 MB because images are re-encoded (≤2000 px long edge, JPEG q≈85) before embedding. → Task 3 test.
3. **Email-flow request with factoring PENDING** — still not READY (regression guard). → Task 1 test.
4. **Portal request READY, then staff request a new factoring notice** — stays READY, `ready_at` kept. → Task 1 test.
5. **No-JS post of three gallery images via "Choose file"** — one 3-page PDF version stored. → Task 3 test.

---

## File structure

| Path                                                                                                                                                               | Responsibility                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| iwd `src/onboarding/readiness.js`                                                                                                                                  | flow-aware `operationsState`, load board report/confirm/undo rules, `loadBoardStatuses` |
| iwd `src/onboarding/portalEmails.js`, `portalFlow.js`                                                                                                              | `PORTAL_CARRIER_SLOTS` without FACTORING                                                |
| iwd `src/onboarding/factoringBackfill.js` (new)                                                                                                                    | one-time READY re-evaluation for portal requests                                        |
| iwd `src/onboarding/files/combine.js` (new)                                                                                                                        | images → one PDF                                                                        |
| iwd `src/onboarding/portal/routes.js`                                                                                                                              | multipart up to 10 files, uses `prepareUpload`                                          |
| iwd `src/onboarding/portal/steps.js` (new)                                                                                                                         | `portalSteps(row)` pure step-state model                                                |
| iwd `src/onboarding/portal/views.js`, `loadBoards.js`                                                                                                              | timeline, upload rows, all-set card, ready hero, per-board load board                   |
| iwd `src/onboarding/portal/static/portal.css`, `portal.js`                                                                                                         | theme, photo button rule, photo list                                                    |
| Outreach `packages/contracts/src/sales.ts`                                                                                                                         | `carrierDocumentsOutstanding(items, { portal })`                                        |
| Outreach `apps/web/src/features/sales/{LoadBoardAccess,OnboardingDocuments,OnboardingPanel,OnboardingList}.tsx`, `apps/api/src/modules/sales/application/today.ts` | per-board lines, Optional factoring, callers                                            |

---

### Task 1: Factoring optional for portal onboardings (iwd)

**Files:** Modify `src/onboarding/readiness.js`, `src/onboarding/portalEmails.js`, `src/onboarding/portalFlow.js`, `src/onboarding/workers.js`; Create `src/onboarding/factoringBackfill.js`; Test `__tests__/onboarding/portalPrimitives.test.js`, `__tests__/onboarding/portal.integration.test.js`

**Interfaces — Produces:** `operationsState(items, { portal = false } = {}) → "PENDING"|"COMPLETE"` (portal: the FACTORING slot and any FACTORING_NOA/NOT_FACTORING item are ignored); `facetsOf(row)` and `buildStatus` pass `{ portal: !!row.portal_flow }`; `PORTAL_CARRIER_SLOTS = ["W9","INSURANCE_COI","AUTHORITY_VERIFIED"]`; `readyAfterFactoringChange(db, now) → number` (portal requests not cancelled/purged, `ready_at` null, readiness now READY → `applyFacetChange(tx,row,{operations: row.operations},now)` forcing the READY side effects; run once at worker start like `addLoadBoardItem`).

- [ ] **Step 1: Failing tests**
    - `portal operations complete with factoring PENDING / RECEIVED / REUPLOAD_REQUESTED / NOT_FACTORING RECEIVED` (all other slots VERIFIED, LOAD_BOARD_ACCESS VERIFIED) → `operationsState(items,{portal:true}) === "COMPLETE"`.
    - `email-flow operations stay PENDING while factoring is PENDING` → `operationsState(items) === "PENDING"` (Review Focus 3).
    - `portal reminders never list factoring` → `portalMissingSteps(row)` has no "Factoring" label.
    - Integration `READY portal request stays READY after a factoring re-upload request` → `request_reupload FACTORING_NOA` keeps readiness READY and `ready_at` (Review Focus 4).
    - Integration `backfill readies a portal request whose only gap was factoring; email-flow untouched` → returns 1; `ready_at` set, status event written, Client ACTIVE; second run returns 0.
- [ ] **Step 2:** `npm test -- __tests__/onboarding/portalPrimitives.test.js` and `npm run test:integration` → the new tests FAIL.
- [ ] **Step 3:** Implement. `applyFacetChange(tx, row, changes, now, { reevaluate = false } = {})` currently returns early when `changes` produce no field difference; with `reevaluate: true` and the derived readiness READY while `row.ready_at` is null, it continues: sets `ready_at`/`purge_after`, bumps version, writes the status event and runs the existing READY client-status update. The backfill calls it with `{}` changes and `{ reevaluate: true }`.
- [ ] **Step 4:** Both suites PASS (all existing tests too).
- [ ] **Step 5:** Commit `feat(onboarding): factoring optional for portal onboardings`.

### Task 2: Load board per-board confirmation (iwd)

**Files:** Modify `src/onboarding/readiness.js`; Test `__tests__/onboarding/portalPrimitives.test.js`, `__tests__/onboarding/portal.integration.test.js`

**Interfaces — Produces:**

- `reportLoadBoard(items, { board, note, at })`: after VERIFIED, adds the board to `reported` and keeps state VERIFIED (returns new items; returns `null` only when nothing changes — board already reported).
- `confirmLoadBoardAccess(items, { boards, note, actor, at })`: sets confirmed `boards`; keeps `reported`.
- `unverifyOperationItem(items, "LOAD_BOARD_ACCESS")`: clears `boards`; state `RECEIVED` when `reported` non-empty, else `PENDING`; keeps `reported`.
- `loadBoardStatuses(item) → Array<{ board: "DAT_ONE"|"TRUCKSTOP"|"OTHER", name: string|null, state: "CONFIRMED"|"WAITING" }>` (confirmed ∪ reported, DAT_ONE, TRUCKSTOP, OTHER order; OTHER name from note/reported_note).

- [ ] **Step 1: Failing tests**: `Added after confirmation records the board and stays VERIFIED`; `Added twice for a confirmed board changes nothing` (Review Focus 1: `reportLoadBoard` returns null, `reported` has one DAT_ONE); `undo with reported boards → RECEIVED, without → PENDING`; `loadBoardStatuses marks confirmed vs waiting`; integration: portal POST `/load-board` for TRUCKSTOP after `confirm_load_board_access {boards:["DAT_ONE"]}` → item VERIFIED, `reported` includes TRUCKSTOP, status `reported_boards` includes TRUCKSTOP.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run both suites → PASS.
- [ ] **Step 5:** Commit `feat(onboarding): load board boards confirmed one by one`.

### Task 3: Multi-photo → one PDF (iwd)

**Files:** Create `src/onboarding/files/combine.js`; Modify `src/onboarding/portal/routes.js` (multipart), `src/onboarding/files/validate.js` (export detection if needed); Test `__tests__/onboarding/uploadCombine.test.js`, `__tests__/onboarding/portal.integration.test.js`

**Interfaces — Produces:** `prepareUpload(files: Buffer[], { maxBytes }) → Promise<{ ok: true, bytes: Buffer } | { ok: false, code: "empty"|"too_many_pages"|"mixed_files"|"too_large"|"unsupported_type" }>`: 1 file → returned as is (existing `recordUpload` validates it); >10 → `too_many_pages`; sum >maxBytes → `too_large`; any PDF among ≥2 files → `mixed_files`; images (validated by `validateUpload`, HEIC converted) → each re-encoded with sharp (`rotate()`, fit inside 2000×2000, JPEG q85) → pdf-lib page per image on US Letter (612×792 pt, landscape 792×612 when the image is wider than tall), image scaled to fit with 36 pt margins, centered → result >maxBytes → `too_large`. Multipart: `limits.files = 10`, `parts = 12`, collects `file` fields into an array (per-file `fileSize: maxBytes + 1`).

- [ ] **Step 1: Failing tests**: `two JPEGs become one two-page PDF` (pdf-lib `getPageCount() === 2`); `HEIC + PNG combine`; `PDF with an image → mixed_files`; `11 images → too_many_pages`; `sum over 15 MB → too_large`; `6000×8000 PNG combines under 15 MB` (Review Focus 2); `single PDF passes through unchanged`; integration `no-JS post of three images stores one 3-page PDF version` (Review Focus 5) and `refused set stores nothing (no R2 put, no row)`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run both suites → PASS.
- [ ] **Step 5:** Commit `feat(onboarding): several photos become one PDF`.

### Task 4: Timeline, upload rows and load board views (iwd)

**Files:** Create `src/onboarding/portal/steps.js`; Modify `src/onboarding/portal/views.js`, `src/onboarding/portal/loadBoards.js`, `src/onboarding/portal/static/portal.css`, `src/onboarding/portal/static/portal.js`; Test `__tests__/onboarding/portalViews.test.js` (new), existing portal tests updated where markup changed

**Interfaces:**

- Consumes: `loadBoardStatuses` (Task 2), `operationsState(…,{portal})`, `PORTAL_CARRIER_SLOTS` (Task 1).
- Produces: `portalSteps(row) → { doneCount: 0..4, steps: Array<{ id: "sign"|"payment"|"documents"|"loadBoard"|"about", state: "done"|"current"|"upcoming"|"optional", summary: string }>, phase: "working"|"allSet"|"ready"|"closed" }`. done: sign = signature COMPLETED; payment = READY or PENDING_VERIFICATION; documents = W9, INSURANCE_COI, AUTHORITY_VERIFIED each RECEIVED or VERIFIED; loadBoard = item VERIFIED. current = first not-done required step (none when all done). phase: closed if cancelled; ready if readiness READY; allSet if doneCount 4 and not READY; else working.

Copy fixed by the spec (exact): header `"{n} of 4 steps done"`; current label `"You are here"`; all-set card `"All set on your side. Iron Wing is reviewing your documents and setting up your account — you'll see You're ready here when we're done. Nothing else to do."`; ready hero heading `"You’re ready"` (keep the existing ready text and 30-day note); load board waiting `"Added · waiting for Iron Wing to confirm"`, confirmed `"Confirmed by Iron Wing"`; result line `"You added a seat on {board} for {dispatcher}. Waiting for Iron Wing to confirm access — it will show a green check here."`; factoring row `"Optional"` + `"Only if you use a factoring company"`; guide links `"Official DAT guide ↗"` (DAT URL in spec) and `"Official Truckstop guide ↗"` (Truckstop URL), `target="_blank" rel="noopener noreferrer"`.

Markup rules: each step is `<details>` with `open` on the current step, on a step with an error/just-done anchor, and none otherwise; upload rows per the mockup states (needed / received / verified / new upload requested with reason); per document row two inputs: "Choose file" `<input type="file" name="file" multiple accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif">` and a `<label class="take-photos">` for `<input type="file" name="file" accept="image/*" capture="environment">`; no "I don't factor" form; JS (progressive) keeps a per-row photo list with thumbnails (`URL.createObjectURL`), remove buttons (`aria-label="Remove page N"`), "Add page", and posts all photos with the CSRF field via `fetch` (same-origin) to the existing upload URL; button text `"Send {n} pages as one PDF"`.

- [ ] **Step 1: Failing tests** (`portalViews.test.js`): `portalSteps` for unsigned / signed+paid / documents partly / all four done not READY (`phase "allSet"`, no current) / READY / cancelled; rendered page: header count text; exactly one `<details open` for the current step; done steps contain the check icon class and summary; all-set card text; ready hero; factoring row has "Optional" and no `/not-factoring` form; `take-photos` label with `capture="environment"` present and the CSS file contains the `(hover: none) and (pointer: coarse)` rule; load board per-board states and both guide links; reasons and names escaped (`<script>` in a reason renders escaped).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement views/CSS/JS per the mockups. **Step 4:** Both suites PASS.
- [ ] **Step 5:** Screenshots at 390 px and 1280 px for: documents in progress (mid multi-photo is JS state — capture the static rows), load board current with one waiting board, all set, ready — save under `docs/operations/onboarding-portal-acceptance/redesign-*.png` (Chromium `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`, synthetic data via the preview approach).
- [ ] **Step 6:** Commit `feat(onboarding): timeline portal with upload rows and per-board load boards`.

### Task 5: Outreach — factoring optional and per-board load boards

**Repo:** `/home/olorin4/web-dev/outreach`

**Files:** Modify `packages/contracts/src/sales.ts`, `apps/web/src/features/sales/LoadBoardAccess.tsx`, `apps/web/src/features/sales/OnboardingDocuments.tsx`, `apps/web/src/features/sales/OnboardingPanel.tsx`, `apps/web/src/features/sales/OnboardingList.tsx`, `apps/api/src/modules/sales/application/today.ts`; Tests `apps/api/src/modules/sales/onboarding-contract.test.ts`, `apps/web/src/features/sales/LoadBoardAccess.test.tsx`, `apps/web/src/features/sales/OnboardingDocuments.test.tsx`, `apps/api/src/modules/today/today.integration.test.ts`

**Interfaces — Produces:** `carrierDocumentsOutstanding(items, { portal = false } = {}) → boolean` (portal: factoring keys ignored). Callers pass `{ portal: Boolean(progress.portal?.flow) }` (panel, list) and the stored status's `portal?.flow` (today.ts).

- [ ] **Step 1: Failing tests**: contract `portal: outstanding false when only factoring is PENDING; email flow true`; `LoadBoardAccess shows each board as "Confirmed" or "Waiting for confirmation" and pre-ticks confirmed ∪ reported`; `OnboardingDocuments shows "Optional" on the factoring row for portal onboardings`; Today integration `portal onboarding with only factoring missing is not "documents outstanding"`.
- [ ] **Step 2:** `npm test` (web + api), `OUTREACH_INTEGRATION=1` Today/Sales on a disposable Postgres → FAIL. **Step 3:** Implement. **Step 4:** PASS; `npm run typecheck`; lint on changed files.
- [ ] **Step 5:** Commit `feat(sales): optional factoring and per-board load boards on the panel`.

### Task 6: Acceptance and record

- [ ] **Step 1:** Run iwd `npm test` + `npm run test:integration`; Outreach `npm test` + Sales/Today integration. All green.
- [ ] **Step 2:** Restart the live preview (`scratchpad/portal-preview.mjs`) with states covering the four screenshots; send the owner the screenshots.
- [ ] **Step 3:** Append a "Redesign (2026-11-19)" section to `docs/operations/onboarding-portal-acceptance.md` (what changed, release order, factoring portal-only, no email changes); commit. Do not push iwd `master` (push deploys) until the owner says so.
