# Onboarding portal — acceptance record

Plan: `docs/superpowers/plans/2026-11-18-client-onboarding-portal.md` (Task 17). Branch
`feat/client-onboarding-portal` in iwd-backend and Outreach. Status: **sandbox acceptance passed 2026-11-18**; owner inbox confirmation pending.

## Done (2026-11-18)

- **Task 1 (SignWell check):** in test mode the carrier recipient reads `waiting` before Iron Wing
  signs and `sent` after, with an embedded signing URL; with `send_email: false` the owner received
  no carrier email in either inbox. The synthetic envelope was deleted.
- **Tasks 2–16 built**, then reviewed against the plan. Fixed after review: verify is bound to the
  reviewed document version (`document_id`, 409 `document_changed`); leaving READY rotates an
  expired link instead of reviving it; TIN filter (mixed/dotted separators; only a state ZIP+4 is
  spared); forms work without JavaScript (`Sec-Fetch-Site: same-origin` when Origin is null);
  first signed page offers the download; retention runs without the portal switch and dates
  older requests; portal failures are logged with a redacted path (any letter case); large photos
  reach the reader as a ≤2000 px JPEG copy.
- **Edge (kelevoTMS dev, authoritative):** `onboarding.iron-wing.conf` (43040a1fc); staff upload
  route on `outreach.getkelevo.com` accepts 16 MB, and `/p/` on `api.` returns 404 unlogged
  (8841b5539). Checked with a local nginx: 2 MB passes the upload route and the portal host, is
  refused (413) elsewhere; the token never reached the logs.
- **Tests:** iwd 631 unit + 156 integration; Outreach 1,088 web + 2,831 API unit + 543
  integration (disposable UTC PostgreSQL). Shared portal fixture identical in both repos.
- **Look:** `onboarding-portal-acceptance/mobile.png` (390 px) and `desktop.png` (1280 px),
  synthetic data. Approved by the owner with the email texts (2026-11-18).

## Sandbox end-to-end run (2026-11-18)

Disposable PostgreSQL 14, SignWell test mode, Stripe test keys, private R2 bucket
`iwd-onboarding-docs-test` (scoped Object Read & Write key; encrypted put/get/delete checked first),
AI reader `claude-opus-5-5`, local portal `http://localhost:3499`. Carrier `nick.kalas@proton.me`,
Iron Wing signer `onboarding@iron-wing-dispatching.com`; the run refused any other address and
capped app emails at 3 (+2 SignWell completed copies = 5).

1. Packet sent (SignWell 422 not-ready handled by retry); waiting for Iron Wing.
2. Owner signed as Iron Wing (embedded link) → within one reconcile pass the portal invitation went
   to the carrier (app email 1). No SignWell signing email to the carrier.
3. Owner, as carrier, on the portal: signed (embedded), saved the Stripe test card (payment READY),
   uploaded W-9, certificate of insurance and authority, chose "I don't use factoring", answered
   the questionnaire.
4. Reader: authority (MC/USDOT match, no flags); COI flagged `insurance_expiring_30d` (expiry
   2026-12-08); W-9 stored `tin_last4` "6789" only — no full TIN anywhere in the database; the
   ZIP+4 address was kept.
5. Staff: re-upload requested for the COI with a reason (app email 2); a renewed COI uploaded as
   staff (version 2, read with no flags); all six items verified against their current versions;
   provisioning confirmed manually.
6. Result: READY, `ready_at` set, purge date 2029-11-18. 2 of 3 app emails used.

Owner approved the email texts and the page look (2026-11-18).

## Release notes (Task 18, owner-gated)

- Deploy **Outreach before or with iwd-backend**: an older Outreach cannot parse a status that
  contains `REUPLOAD_REQUESTED`.
- Re-upload requests and staff uploads apply to portal-flow requests only; legacy requests keep
  "Mark received" / "Verify".

## Portal polish (2026-11-19)

- **Load board access** follows Documents. The carrier assigns a separate DAT One or Truckstop
  seat to the named Iron Wing dispatcher. The dispatcher creates their own login with the
  provider. Iron Wing confirms access separately from the onboarding readiness checklist.
  DAT's steps match its published guide; Truckstop's article renders only with JavaScript, so
  its menu names were only partly confirmed (see the 2026-11-19 review).
  [DAT One seat setup](https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870),
  [Truckstop Account Management](https://community.truckstop.com/s/article/Account-Management-Tool).
- **Factoring** is recorded as `NOT_FACTORING` / `RECEIVED` for staff review. The form returns
  to the factoring row with a confirmation specific to that choice.
- **Browser verification** used a disposable local database and synthetic data with no outbound
  email.

## Header and footer restored (2026-11-19, owner)

The public site's navbar, footer, newsletter and social links were removed again (owner). The
portal keeps its own header (logo and the legal name, Iron Wing Logistics L.L.C.) and its
one-line footer with onboarding@iron-wing-dispatching.com as the only contact. Captured with
synthetic data at [390 px](onboarding-portal-acceptance/mobile-restored.png) and
[1280 px](onboarding-portal-acceptance/desktop-restored.png).

## Load board access tracking (2026-11-19, owner)

- New staff-only checklist item `LOAD_BOARD_ACCESS`, **required for READY**. A closer confirms it
  in Outreach (Sales → onboarding panel → "Load board access") by ticking DAT One, Truckstop or
  Other (with its name); Undo returns it to unconfirmed. No logins are stored. Never in carrier
  reminders; the portal's load board step shows "Iron Wing confirmed access to …" once confirmed.
- Release: Outreach (5e543fa) before or with iwd-backend (41097fa) — older Outreach rejects the
  new item key. On start, iwd's workers add the item (PENDING) to requests still in progress;
  READY, cancelled and purged requests keep their six items and stay complete.
- The carrier's load board step asks for at least one board (DAT One, Truckstop or another), more allowed; staff confirm
  any one or more. When the onboarding is READY the page opens with a "You’re ready ✓" card
  ([390 px](onboarding-portal-acceptance/mobile-ready.png),
  [1280 px](onboarding-portal-acceptance/desktop-ready.png)).
- The load board step names the dispatcher (settings `ONBOARDING_DEFAULT_DISPATCHER_NAME` /
  `_EMAIL`, or a closer's assignment in Outreach) inside the DAT One and Truckstop steps. Each
  board ends with an **Added** button (another board takes its name); the step then says "You
  added a seat on … for {dispatcher}. Iron Wing will check access and confirm it here." Outreach
  shows "Carrier reports: …" with those boards pre-ticked for the closer to confirm. No email links.
- Release: set the two dispatcher settings — Nick Kalas, nick-kalas@iron-wing-dispatching.com (owner, 2026-11-19) — (server `.env` + GitHub secrets; the pipeline already
  writes them). Migration `20261119120000_onboarding_dispatcher` adds two columns.
