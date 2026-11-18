# Client onboarding portal — design

Date: 2026-11-18. Status: **approved by the owner 2026-11-18**.
Builds on: permanent client onboarding (`docs/operations/client-onboarding.md`), Outreach
modernization design and ledger (`outreach/docs/superpowers/specs/2026-11-18-workflow-modernization-design.md`,
`…/plans/2026-11-18-workflow-modernization-ledger.md`, rulings R12–R18).

## Why

The owner wants a private web page per new Iron Wing carrier client so that onboarding:

1. **integrates with the Outreach Sales workflow** — the closer sees every step, document and
   extracted value on the opportunity's onboarding panel, live, without leaving Outreach;
2. **sends fewer emails** — the carrier hears only from Iron Wing, with one link, instead of
   SignWell requests, a combined email with attachments and reply-with-attachments requests;
3. **makes uploads easy** for the carrier, including from a phone;
4. **handles documents automatically** — private storage (R2) and an AI document reader that
   fills the iwd-backend database, with mismatches flagged for the team.

## Owner decisions (2026-11-18)

- Hosted by **iwd-backend** on the existing VPS at **`https://onboarding.iron-wing-dispatching.com`**
  (Cloudflare-proxied DNS; edge-nginx; the existing `*.iron-wing-dispatching.com` origin certificate).
- **Signing moves onto the page** (SignWell embedded signing for the carrier).
- **The carrier hears only from us.** SignWell must not email the carrier a signing request.
  SignWell's completed-document email is acceptable but not required.
- **Final optional questionnaire** replaces documents item 5 (carrier profile): equipment,
  lanes, minimum rates, excluded freight, other preferences. It never blocks readiness; the
  closer satisfies the CARRIER_PROFILE checklist item in Outreach from the closing call, with any
  questionnaire answers shown alongside.
- **Extracted data** lives in the iwd-backend database and is shown in the Sales workflow. Kelevo
  integration comes later (out of scope).
- Unchanged: Iron Wing signs first in Outreach (R14, embedded, owner only); the carrier signs
  last (R12); payment via Stripe-hosted setup; provisioning manual (PRD-0020 deferred).

## Goals

- One private, mobile-friendly page per onboarding request showing the steps in order:
  **① Sign → ② Payment → ③ Documents → ④ Questionnaire (optional)**, plus **Download your signed agreement**.
- The carrier can come back at any time with the same link until onboarding is finished.
- Each upload (from the carrier, or from staff when a document is missing) is stored privately, marked **Received**, read by the AI reader, and shown in
  Outreach with extracted values and flags; a team member **verifies** each document.
- Emails to the carrier: (1) one invitation with the page link, sent when Iron Wing has signed;
  (2) at most two reminders listing what is still open. Nothing else from Iron Wing.

## Non-goals

- Kelevo provisioning or data transfer (later).
- Carrier accounts/passwords, a carrier dashboard after onboarding, or ongoing document renewals
  (e.g. insurance renewal reminders after go-live) — possible later.
- Collecting card/bank numbers anywhere except Stripe's hosted page.
- Replacing Outreach as the staff tool; staff never use the portal.

## Anti-goals (failure even if it "works")

- AI marks a document verified, or a wrong/expired document reaches READY without a human click.
- A tax ID (W-9 TIN) stored in clear text in the database, logs, Outreach or R2.
- A portal link that works for anyone other than the intended carrier's request, or that exposes
  another carrier's data or documents.
- The carrier receiving SignWell signing emails, or more Iron Wing emails than today.
- Uploads that can execute, render as HTML, or be served publicly.

## Constraints

- iwd-backend: ESM JavaScript, Express, Prisma 7, existing onboarding module (`src/onboarding/**`),
  status contract `onboarding.status.v1` (additive changes only), signature v2 for Outreach→iwd.
- Interim billing is live in the same app: no behaviour change there.
- Every new iwd-backend setting must be added to the server `.env`, as a GitHub secret **and** to
  the CI pipeline's `.env` generation (ledger rule), or the next CI deploy drops it.
- Documents contain personal and tax data: encrypt before storage, log every staff access.

## Approaches considered

| Approach | Trade-offs | Decision |
| --- | --- | --- |
| **A. iwd-backend serves the portal on its own subdomain** | Same app as the onboarding logic: no CORS, one deploy, link handling and uploads stay server-side. Look matched to the website by hand. | **Chosen** (owner picked the `onboarding.` subdomain) |
| B. Page on the Astro website calling iwd-backend | Exact site look and domain, but cross-site requests, uploads across domains, browser-side token handling and two deploys per change. | Rejected |
| C. Inside Outreach | Outreach is on `getkelevo.com`; Iron Wing carriers must not land on Kelevo's domain. | Rejected |

## Design

### Access (private link)

- When Iron Wing has signed (signature waiting_for → CARRIER), iwd-backend emails the carrier
  `https://onboarding.iron-wing-dispatching.com/p/<token>`. The token is an HMAC-signed,
  random-id token bound to the onboarding request (like the continue token, separate secret),
  valid until the request is READY or CLOSED plus 30 days, and revocable.
- The page sets no cookies beyond a CSRF-protecting same-site token for form posts; every response
  is `no-store`, `noindex`, `Referrer-Policy: no-referrer`, strict CSP (self only, plus the
  SignWell signing origin if embedded in a frame), and the token never appears in logs.
- Outreach gains a closer action **"Send the onboarding page link again"** (new token, old one
  revoked) and shows when the carrier last opened the page.
- Host routing (edge vhost committed in kelevoTMS `infra/staging/conf.d/onboarding.iron-wing.conf`,
  the authoritative edge config; not yet on the box): the edge proxies **only `/p/…` and
  `/portal-static/…`** to iwd-backend and returns 404 for everything else; it logs no request URIs,
  allows 16 MB bodies and sends `X-Robots-Tag: noindex`. iwd-backend also refuses portal routes on
  other hosts and API/admin routes on the portal host. All portal pages, uploads and the Stripe /
  SignWell return URLs live under `/p/<token>/…`; static files under `/portal-static/`.
- iwd-backend's own logging must not record portal paths either: today `morgan("combined")` writes
  every ≥400 response URL to `logs/access.log` — portal paths must be redacted or skipped there and
  in any error logging. CORS already allows the portal origin (3314316).

### Page

Server-rendered HTML (small vanilla JavaScript for uploads with progress, status refresh after
signing and payment), Iron Wing colours and logo, works on a phone. Sketch:

```
Iron Wing Logistics L.L.C. — onboarding for Example Freight LLC
 ① Sign your agreement      Done ✓ (Nov 18)          [Download signed agreement]
 ② Save payment method       [Save on Stripe]   — unlocked after ①; "Saved ✓ card •••• 4242"
 ③ Documents                 W-9            [Upload]   Received — we're reviewing it
                             Insurance cert [Upload]   Verified ✓
                             Authority copy [Upload]   Needed
                             Factoring      [Upload notice] or [I don't use factoring]
 ④ About your operation (optional)  [Answer a few questions]
 Questions? Reply to the email or write to onboarding@iron-wing-dispatching.com
```

- ① opens the carrier's SignWell embedded signing link (new tab by default; inline frame only if
  SignWell permits our domain — builder verifies). Steps ②–④ unlock after ① is COMPLETED
  (verified by re-fetch, as today). The signed packet download is served from iwd storage.
- ② reuses the continue flow; Stripe's success/cancel URLs return to the page.
- ③ one slot per required document; re-upload allowed until Verified (a new upload replaces the
  pending one and keeps history); "I don't use factoring" satisfies the factoring item.
- ④ questionnaire (optional): equipment type(s) and count, home base, preferred lanes/regions,
  minimum rate (per mile or per load), freight not hauled (e.g. hazmat), max deadhead,
  availability, other preferences (free text). Builder may refine field types.

### Emails (transactional, from iwd-backend, reply-to onboarding@)

- **Invitation** (when Iron Wing has signed): subject `Your Iron Wing onboarding page — {Legal name}`;
  short text: what to do, the page button/link, that payment details are only on Stripe's page.
  Replaces the SignWell carrier email and the R15 combined email.
- **Reminders** (≤2, R15 timing: 3 and 7 business days after the invitation, only while a required
  step is open, stop on complete/cancel/pause): list what is open and link to the page.
- No other carrier emails. Exact texts go to the owner for approval before release (as R15).

### SignWell

- Carrier recipient: embedded signing with `send_email: false` (no SignWell signing email);
  Iron Wing unchanged (R14). The carrier's embedded URL is fetched server-side when the carrier
  opens step ①, never stored in logs.
- Completed-document email: allowed (owner); the portal download is the primary copy.

### Documents and storage

- Accepted: PDF, JPEG, PNG, HEIC (converted to PDF/JPEG for reading); ≤15 MB each; type checked
  by content (magic bytes), not by file name; anything else refused with a plain message.
- Stored in a **new private Cloudflare R2 bucket** for iwd-backend, **encrypted by iwd-backend before
  upload** (AES-256-GCM, key in `.env`); object keys carry no personal data; never public.
- Staff access only through Outreach (closer/owner), streamed through iwd-backend with
  `Content-Disposition: attachment`, logged in `document_access_log`.
- Signed packets stay where they are today (encrypted volume) unless the builder moves them to R2
  as part of this work (builder's call; keep one storage abstraction).

### AI document reader

- Runs inside iwd-backend after each upload (background job with retries), calling Claude
  directly with the file; structured output validated by Zod.
- Extracts, per document type:
  - **W-9:** legal name, business name, entity type, TIN type, **last 4 digits of the TIN only**,
    address, signature present, signature date.
  - **Insurance certificate:** insurer(s), policy numbers, coverages (auto liability, cargo,
    general liability) with limits, effective and expiry dates, certificate holder.
  - **Operating authority:** MC/DOT numbers, legal name, authority type, date.
  - **Notice of assignment:** factoring company name, remittance address, contact, effective date.
- Flags (never decisions): name differs from the agreement's legal name; MC/USDOT differs;
  insurance expired or expiring within 30 days; unreadable/wrong document type; missing signature.
- Stores extracted fields and flags per document version; the full TIN is never stored outside the
  encrypted file; prompts/outputs are not logged with document content.
- If the reader fails or is disabled, the document is still Received and staff verify manually.

### Owner answers to the builder check (2026-11-18)

1. **Rejecting a document:** approved as proposed — a "please re-upload" state with a short staff
   reason shown on the page, and one email telling the carrier; that email counts toward the two
   reminders (no extra emails). Staff can also undo a Verified.
2. **Access:** the private link alone is enough (no second check), as with the Stripe link and
   SignWell today. The page offers the signed agreement and the carrier's own uploads for download.
3. **AI reader:** the whole file goes to Anthropic's API with standard handling; no blacking out of
   the tax ID before sending. iwd still stores only the last 4 digits outside the encrypted file.
4. **Retention:** abandoned onboarding → documents and extracted data deleted **90 days** after the
   request ends without completing; successful onboarding → kept **3 years**.
5. **Staff upload in Outreach:** added. The upload control appears only when the item has no
   document (nothing uploaded yet, or the last upload was rejected). Staff uploads go through the
   same storage, AI reader and flags, recorded with the staff actor.

### Retention (from answer 4; details are the builder's calls, recorded)

- "Abandoned" = the request is cancelled or its opportunity lost (staff action); purge runs 90 days
  after that. Requests left idle are not purged automatically; they stay visible to staff until
  someone cancels them.
- "Successful" = the request reached READY; purge runs 3 years after READY.
- A daily job deletes the R2 objects, extracted fields and flags, and the stored signed packet copy
  for purged requests; it keeps a content-free record (document type, dates, file hash, who
  uploaded/verified, purge date) for the audit trail. Portal links for purged requests stop working.

### Checklist and readiness

- Items: PENDING → RECEIVED (automatic on upload) → VERIFIED (staff), plus **REUPLOAD_REQUESTED**
  (staff, with reason) → back to RECEIVED on the next upload. Staff can move VERIFIED back to RECEIVED.
  The status contract gains the new state additively (old readers treat unknown states as not done).
- CARRIER_PROFILE: satisfied by the closer in Outreach (questionnaire answers shown alongside);
  never blocks on the carrier.
- FLEET_MAPPING stays internal.
- READY still requires signature COMPLETED, payment READY, provisioning SUCCEEDED/MANUAL_CONFIRMED
  and every required item VERIFIED.

### Outreach (Sales workflow) — in scope, same build

Outreach changes ship with this work (two repos, one contract amendment), following the existing
pattern: Outreach server proxies to signed iwd endpoints with brand scoping and closer/owner role
checks, the web app shows the result in the `/app` Sales area.

- Onboarding panel per document: state, upload time, extracted values, flags, **View file**
  (proxied, logged), **Verify**, **Ask for a new upload** (reason), **Undo verify**, and
  **Upload** (only when the item has no document); questionnaire answers; portal last opened;
  resend link.
- Status contract `onboarding.status.v1`: additive optional fields for per-item document version,
  extraction status, flags summary, questionnaire present, portal last opened. Detailed extracted
  values are fetched on demand by a new signed iwd endpoint (not pushed in every status event).
- Today: existing "Documents outstanding" card; add a "Documents to verify" card when items are
  RECEIVED and not yet verified.

### SignWell assumptions (builder's call, recorded)

- Verify in the SignWell sandbox first that the carrier recipient can use embedded signing with
  `send_email: false`, and how recipient statuses look in that mode. If SignWell cannot suppress
  the carrier's signing email, stop and bring it to the owner before building around it.
- Expiry/reissue: the portal token belongs to the onboarding request, not the envelope; a reissued
  envelope simply appears on the same page. A reissue does not send a new invitation; the carrier is
  told only if the closer resends the link.

## Settings (new)

`ONBOARDING_PORTAL_BASE_URL`, `ONBOARDING_PORTAL_TOKEN_SECRET`, R2 (`ONBOARDING_R2_ACCOUNT_ID`,
`ONBOARDING_R2_BUCKET`, `ONBOARDING_R2_ACCESS_KEY_ID`, `ONBOARDING_R2_SECRET_ACCESS_KEY`),
`ONBOARDING_FILE_ENCRYPTION_KEY` (may reuse the document key — builder's call),
`ANTHROPIC_API_KEY` + `ONBOARDING_DOC_READER_MODEL`, `ONBOARDING_DOC_READER_ENABLED`. Each added to
the server `.env`, GitHub secrets and the CI pipeline.

## Rollout

Behind `ONBOARDING_PORTAL_ENABLED` (default off). While off, today's flow (SignWell carrier email,
R15 combined email) keeps working unchanged. Turning it on switches new requests to the portal
flow; requests already in flight finish on the old flow. DNS + nginx config added before enabling.
Sandbox acceptance (test mode, capped emails) before the switch.

## Left to the builder

Page markup/CSS and component structure; job runner for the reader; exact Zod schemas for
extraction; migration shapes; HEIC conversion library; whether signed packets move to R2; precise
questionnaire field types; test strategy (with sandbox acceptance like R14/R15).
