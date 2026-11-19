# Onboarding portal redesign — design

Date: 2026-11-19. Status: **approved by the owner 2026-11-19**.
Builds on: `2026-11-18-client-onboarding-portal-design.md` (live, switch off) and the acceptance
record `docs/operations/onboarding-portal-acceptance.md`.
Mockups (owner-reviewed): https://claude.ai/artifact/82iiKdcyAZV6Uqv7y2yiWu — row "Chosen: B timeline +
A upload rows" (documents in progress, load board step, You're ready).

## Why

The carrier page works but looks like a plain form. The owner wants it modern and aligned with the
Iron Wing front page, with progress that is obvious at a glance: bigger numbers, prominent
completion graphics, cards that collapse and expand, and done / current / upcoming steps that look
clearly different. Uploads should be easier on a phone (several photos of a multi-page document),
factoring should stop blocking carriers who don't factor, and load board progress should show what
Iron Wing has actually confirmed.

## Owner decisions (2026-11-19)

1. **Look: proposal B (gold timeline) with A's upload rows.** Front-page theme: navy `#0b2440` /
   `#08347c`, ink `#080d17`, hero gradient `172deg rgb(0,98,139) → #0b2440`, gold button gradient
   `172deg rgb(255,200,0) → rgb(238,228,141)` with the site's `3px outset #080d17` border, Arial,
   12px card radius. The portal keeps its own header (logo + "Iron Wing Logistics L.L.C.") and
   one-line footer (no site navbar/footer — ruling of 2026-11-19).
2. **Multi-photo to PDF:** a carrier can photograph each page; the photos are combined into one PDF.
3. **Photo button only on mobile:** "Take photos" shows on touch-first devices only; desktops show
   "Choose file" only.
4. **Factoring notice optional — portal onboardings only:** no longer required for READY; the "I don't factor" button goes. Email-flow onboardings (`portal_flow = false`) keep today's rule and the approved email/reminder texts. Factoring **never** blocks READY on a portal onboarding, in any state — even after staff ask for a new notice (staff track that themselves).
5. **Load board per board:** each board the carrier added shows *added — waiting for Iron Wing* until
   staff confirm it, then *confirmed*; the official provider guide is linked for each board.

## Goals

- One page, same URL and steps, restyled as a vertical timeline:
  - **Done step:** gold filled circle with a check, solid gold connector, collapsed to a one-line
    summary (title + key fact, e.g. "Card •••• 4242 · nothing charged"); tap to expand.
  - **Current step:** large navy numeral (56px circle, 30px digit) with a gold halo, label
    "You are here", expanded.
  - **Upcoming step:** grey outlined numeral, dashed connector, collapsed, readable (not locked
    content) unless the step genuinely requires an earlier one (payment and later need signing).
  - Header: near-black band with "N of 4 steps done" and a gold progress bar (required steps only:
    sign, payment, documents, load board). Optional questionnaire stays step 5, never counted.
  - **All set on your side** (all 4 required steps done by the carrier, not READY yet — documents in
  review, bank verification, account setup): header "4 of 4 steps done"; a navy card with a gold
  hourglass: "All set on your side. Iron Wing is reviewing your documents and setting up your account
  — you'll see You're ready here when we're done. Nothing else to do." Same text whatever is pending
  (owner).
- **You're ready:** teal-to-navy hero with a large gold check badge, the completion text, the
    dispatcher card and a gold "Download your signed agreement" button; completed steps listed below.
- Every card is a native `<details>/<summary>` (keyboard and screen-reader friendly, no JS needed);
  the server decides which one is open (the current step; plus any with an error or a just-done
  action anchor).
- Upload rows (A style), one per document, with clear states:
  - *Needed*: dashed row, "Choose file" (+ "Take photos" on mobile).
  - *Received*: green row with file name, "received, we're reviewing it".
  - *Verified*: green row, "Verified ✓".
  - *New upload requested*: amber row with Iron Wing's reason and a gold primary button.
  - Factoring row is marked **Optional** ("Only if you use a factoring company").
- Multi-photo flow (on a document row): take photos one by one → thumbnails ("Page 1", "Page 2"…,
  each removable) → "Add page" → gold "Send N pages as one PDF"; "Upload a PDF instead" link.
- Load board step: dispatcher card (initials avatar, name, email), boards as expandable rows:
  *not added* (empty circle + instructions + official guide link + gold "Added on {board}"),
  *added — waiting for Iron Wing to confirm* (amber clock), *confirmed by Iron Wing* (green check).
  Result line after pressing Added: amber "You added a seat on X for {dispatcher}. Waiting for Iron
  Wing to confirm access — it will show a green check here."
- Works at 390px and 1280px; touch targets ≥44px; text contrast ≥4.5:1.

## Non-goals

- No change to emails, the questionnaire's fields, SignWell/Stripe flows, retention, or Outreach's
  overall layout beyond the panel controls below.
- No client-side framework; the page stays server-rendered with small vanilla JS.
- No real-time push; polling after SignWell/Stripe returns stays as is.

## Anti-goals

- The page must keep working without JavaScript (plain forms; JS only enhances).
- No upload path that bypasses the existing checks (magic bytes, 15 MB, CSRF/Origin, token, logging
  redaction).
- A board must never look confirmed before a staff member confirmed it.

## Constraints

- iwd-backend portal: `src/onboarding/portal/{views.js,loadBoards.js,routes.js,static/*}`; Outreach
  panel: `apps/web/src/features/sales/{LoadBoardAccess,OnboardingDocuments}.tsx`; shared contract
  fixture must stay byte-identical in both repos; status changes additive.
- Release order as before: Outreach before or with iwd-backend. The portal switch is still off in
  production; this ships the same way.
- `docker builder prune -f` before building on hetzner-staging (disk ruling after the 2026-11-19
  incident).

## Approaches considered

| Approach | Trade-off | Decision |
| --- | --- | --- |
| A · Navy dashboard (progress ring, outlined current card) | Strong summary, but steps read as a flat list | Upload rows reused |
| **B · Gold timeline** (numbered nodes on a line) | Clearest done / current / next contrast | **Chosen** |
| C · Hero + 2×2 document tiles | Most modern, cramped on small phones once reasons/two buttons appear | Rejected |
| Photos combined in the browser (JS PDF library) | Needs JS, large client bundle | Rejected: server combines (pdf-lib already present) |

## Design

### Page structure (iwd `views.js`)

- Timeline renderer: each step has `state ∈ {done, current, upcoming}` computed server-side:
  done = sign COMPLETED / payment READY or PENDING_VERIFICATION / documents all required
  RECEIVED-or-VERIFIED / load board ≥1 board confirmed; current = the first required step not done
  (after signing, steps 2–4 are all available; "current" is just the first not done); upcoming = the
  rest. Step 5 (questionnaire) is shown "optional" in its own style.
- Header counts done required steps (0–4) and draws the bar at that fraction.
- Ready hero replaces the old ready card when readiness is READY.
- Styles move to the new theme in `portal.css`; the logo image (`/portal-static/logo.svg`) stays.

### Photo button visibility

`.take-photos { display: none }` and
`@media (hover: none) and (pointer: coarse) { .take-photos { display: inline-flex } }`.
The button is a label for `<input type="file" accept="image/*" capture="environment">`.

### Multi-photo → one PDF (iwd)

- Upload route accepts **up to 10 files** in one multipart post for a document item (field `file`,
  repeated). Rules: one PDF alone → stored as today; 1–10 images (JPEG/PNG/HEIC, each validated by
  magic bytes, HEIC converted) → combined into one PDF, one image per page, scaled to fit US Letter
  (portrait or landscape per image), stored as the item's new version with media type
  `application/pdf`; a PDF mixed with images → refused (`mixed_files`); total bytes ≤ 15 MB before
  combining, and the combined PDF must also be ≤ 15 MB (`too_large`); more than 10 → `too_many_pages`.
- Without JS (builder's call): the "Choose file" input also has `multiple` (no `capture`), so a
  phone can pick several gallery photos for one document; the "Take photos" input stays
  single-shot (`capture` opens the camera once).
- With JS: the page keeps a per-row list of captured photos (thumbnails via `URL.createObjectURL`,
  remove/add page), and posts them together. Without JS: the photo input has `multiple`, so the
  carrier can pick several images from the gallery; the server combines them the same way.
- The reader receives the combined PDF (no change to the reader; PDFs up to 15 MB are fine).
- Staff upload from Outreach stays single-file (PDF or image).

### Factoring optional (iwd + Outreach) — portal onboardings only

- For `portal_flow` requests, the `FACTORING` slot leaves the set required for READY
  (`operationsState` gets the flow, e.g. `operationsState(items, { portal })`) and the carrier-facing
  "missing" lists (portal reminders, header counts). Any factoring item state (PENDING, RECEIVED,
  REUPLOAD_REQUESTED, NOT_FACTORING RECEIVED) is ignored for READY. A re-upload request on the
  factoring notice after READY does not drop the request out of READY. The `FACTORING_NOA` item stays
  on the checklist; a carrier who factors uploads it and staff verify it as before.
- Email-flow requests (`portal_flow = false`): unchanged — factoring still required, R15 email and
  reminder texts unchanged.
- One-time update (builder's call, like `loadBoardBackfill.js`): portal requests whose only gap was
  factoring are re-evaluated through `applyFacetChange` so `ready_at`, the purge date, the status
  event and Client ACTIVE follow. No email is sent (READY sends none today).
- The portal no longer renders "I don't factor"; the `/p/:token/not-factoring` route stays for
  links already in the wild and keeps working (harmless), and `NOT_FACTORING` remains a valid key.
- Outreach shows the factoring row as "Optional" for portal onboardings and keeps Verify for an
  uploaded notice. `carrierDocumentsOutstanding` (contracts package; Today queue, onboarding list,
  panel) stops counting factoring **for portal onboardings** (it reads `portal.flow` from the
  status), so staff get no follow-up tasks for carriers who don't factor (builder's call).
- The closer records whether the carrier factors in the CARRIER_PROFILE note (no new field).
- Existing requests: their checklists are unchanged; readiness simply stops waiting for factoring.

### Load board per-board confirmation (iwd + Outreach)

- `LOAD_BOARD_ACCESS` item keeps `reported` (boards the carrier pressed Added for) and `boards`
  (boards staff confirmed), plus `reported_note` / `note` for OTHER. State: VERIFIED when ≥1 board is
  confirmed, RECEIVED when ≥1 reported and none confirmed, else PENDING.
- Carrier "Added" after the item is VERIFIED is now accepted: it adds to `reported` without changing
  the state (today it is ignored).
- Staff action `confirm_load_board_access { boards, note? }` sets the confirmed set (may add or
  remove boards); `unverify_operation_item LOAD_BOARD_ACCESS` clears confirmations (back to RECEIVED
  if anything reported, else PENDING).
- Status item (additive, already present): `boards` = confirmed, `reported_boards` = reported.
- Portal per board: confirmed if in `boards`; waiting if in `reported` only; else not added.
- Outreach panel: one line per reported or confirmed board with its state, checkboxes to confirm
  (pre-ticked = currently confirmed + newly reported), Confirm / Undo as today.
- Official links: DAT `https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870`;
  Truckstop `https://community.truckstop.com/s/article/Account-Management-Tool` (both open in a new tab).

## Tests (in addition to keeping all existing suites green)

- View: timeline states for each combination (unsigned, signed, documents partly, all done,
  READY, cancelled); header count; open/closed cards; ready hero; factoring "Optional" with no
  "I don't factor"; load board per-board states and guide links; escaping of reasons/names.
- Photo button: present in markup with class `take-photos`, `capture="environment"`, and the media
  rule in `portal.css`.
- Multi-photo: 2 JPEGs → one 2-page PDF version; HEIC + PNG combined; PDF+image refused; 11 files
  refused; combined over 15 MB refused; nothing stored on refusal; no-JS `multiple` post works.
- Readiness (portal): READY with factoring PENDING, RECEIVED, REUPLOAD_REQUESTED or NOT_FACTORING
  RECEIVED; a re-upload request on the notice after READY keeps READY; portal reminders never list
  factoring. Email flow: factoring still required, texts unchanged.
- One-time update: a portal request whose only gap was factoring becomes READY with ready_at,
  purge date, status event and Client ACTIVE; an email-flow request is untouched.
- "All set on your side" card when all 4 steps are done by the carrier but not READY.
- Outreach: `carrierDocumentsOutstanding` ignores factoring for portal onboardings only.
- Load board: Added after VERIFIED keeps VERIFIED and records the board; confirm a subset; undo
  with reported boards → RECEIVED.
- Outreach: panel per-board lines and pre-ticks; factoring row shows Optional.
- Screenshots at 390px and 1280px of the three mockup states, for the owner.

## Left to the builder

CSS structure and class names; the exact JS for the photo list (vanilla, progressive); PDF page
sizing details within "fit to US Letter"; thumbnail sizing; minor copy beyond the texts quoted
above (keep the owner-approved email texts unchanged).
