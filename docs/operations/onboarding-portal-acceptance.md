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
  The menu paths were checked against the provider's published interface guides.
  [DAT One seat setup](https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870),
  [Truckstop Account Management](https://community.truckstop.com/s/article/Account-Management-Tool).
- **Factoring** is recorded as `NOT_FACTORING` / `RECEIVED` for staff review. The form returns
  to the factoring row with a confirmation specific to that choice.
- **Brand** uses the header, footer and shared stylesheet from the Iron Wing homepage at
  `4856e27`. To refresh the snapshot, build the public site and run
  `node scripts/sync-portal-brand.mjs /path/to/iron-wing-dispatching` from iwd-backend.
  The footer newsletter link opens the public site for signup.
- **Browser verification** used a disposable local database and synthetic data with no outbound
  email. Captures show both load board guides expanded at
  [390 px](onboarding-portal-acceptance/mobile-polished.png) and
  [1280 px](onboarding-portal-acceptance/desktop-polished.png).

## Shared footer refresh (2026-11-19)

The portal footer and shared stylesheet were regenerated from the public site's
`Footer.astro` and `shared.css`. Contact, social and newsletter links are grouped, with
privacy and terms in the bottom row. The private portal keeps its public-site signup link.
Verified in Chromium at [390 px](onboarding-portal-acceptance/mobile-footer.png) and
[1280 px](onboarding-portal-acceptance/desktop-footer.png) using synthetic carrier data.
