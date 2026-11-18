# Onboarding portal — acceptance record

Plan: `docs/superpowers/plans/2026-11-18-client-onboarding-portal.md` (Task 17). Branch
`feat/client-onboarding-portal` in iwd-backend and Outreach. Status: **in progress** — the build
and its review fixes are done; the sandbox end-to-end run is not.

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
  synthetic data. Owner approval of look and email texts pending.

## Still to do (Task 17)

1. Sandbox R2 bucket `iwd-onboarding-docs-test` (private) and a credential scoped to it, in the
   local iwd `.env` (mode 0600); verify encrypted put/get/delete with a synthetic file.
2. An Anthropic API key source for the reader in the sandbox.
3. One full sandbox request (disposable DB, SignWell test mode, Stripe test keys, the two owner
   addresses, ≤ 5 emails): send → Iron Wing signs → invitation → portal sign → Stripe test card →
   uploads (synthetic W-9 with a fake TIN, COI, authority, "I don't use factoring") → reader
   values and flags in Outreach → re-upload request → staff upload → verify all → READY.
4. Owner approves the email texts and the page look.

## Release notes (Task 18, owner-gated)

- Deploy **Outreach before or with iwd-backend**: an older Outreach cannot parse a status that
  contains `REUPLOAD_REQUESTED`.
- Re-upload requests and staff uploads apply to portal-flow requests only; legacy requests keep
  "Mark received" / "Verify".
