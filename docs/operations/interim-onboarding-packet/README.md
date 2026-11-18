<!-- TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately. -->

# Interim dispatcher onboarding packet

Prepared November 18, 2026. **Combined packet approved for local release preparation; nothing has been uploaded, sent, signed or provisioned.** This bridge does not change Jack, Outreach, billing code or Kelevo and is not a competing onboarding implementation.

## Contents and release status

- `Iron-Wing-Onboarding-Packet-v3.pdf`: **current** approved six-page combined packet (legal name only; the power of attorney's signature table is `DISPATCH (Agent) | CARRIER`, matching the agreement and the signing order), recorded in `approved-release.json`. `Iron-Wing-Onboarding-Packet-v2.pdf` (`approved-release-v2.json`) is superseded (sandbox test documents only). `Iron-Wing-Onboarding-Packet-v1.pdf` (recorded in `approved-release-v1.json`) is superseded and was never sent; keep it only as history. The current packet is the without review watermark or review footer, for configuring one reusable signature template. It still requires carrier-specific prefill and signature fields before sending.
- `combined-packet.pdf`: retained watermarked review copy. Separate review PDFs and HTML previews are also provided.
- Agreement and limited power of attorney: substantive source wording preserved. Editorial DRAFT/provenance blockquotes omitted from customer copies, based on the owner's report that lawyer review was completed November 17. The source folder's README and draft labels have not been updated.
- Payment authorization: **Stripe-only collection adaptation approved by the owner November 18, 2026.** It removes full card/account/routing fields, replaces them with a Stripe-only instruction, and removes the old editorial handling note. The authorization explicitly covers card and/or ACH details provided through Stripe, with a separate bank-debit correction provision. The commercial terms and revocation text are preserved. See `payment-form-changes.md`.
- The approved PDFs are unwatermarked; earlier review PDFs retain **REVIEW COPY — NOT FOR SIGNING**. These are ordinary PDFs for signature-provider field overlays, not interactive AcroForms or configured SignWell templates. Provider field placement still needs configuration and a controlled signing test.
- `dispatcher-checklist.md`, `email-copy.md`, `signwell-setup.md` and `register-template.csv`: operating assets.
- `source-manifest.json`: hashes of original Markdown files; the originals remain untouched.

## Fast manual path

1. Confirm the closing details using the checklist. A Jack summary alone is insufficient.
2. Use `Iron-Wing-Onboarding-Packet-v3.pdf`, whose approved source hashes and output hashes are recorded in `approved-release.json`. Retain the version/hash; do not overwrite a sent version.
3. Upload the combined packet to a private SignWell template, configure Carrier and Dispatch fields, and test with an explicitly approved internal recipient. No account setup, provider upload or test send has been performed here.
4. For each client, prefill and verify company/authority, fee, effective date and signer details. Send exactly one request after reviewing the actual PDF and recipient.
5. Retrieve the fully executed PDF and audit evidence. Store them privately in the carrier folder; record the provider document ID and packet version.
6. Separately arrange billing enrollment and send the existing Stripe-hosted setup email. This is a real external action in the activated live system and requires deliberate authorization. Do not call billing-run or approval endpoints as part of onboarding.
7. Manually verify the carrier's documents, payment setup and Kelevo/fleet mapping. Mark operationally ready only after every required item is satisfied.

The current billing carrier API accepts empty asset arrays, so a billing record can exist before fleet mapping. However, the public API has no asset-mapping edit route. Decide and verify actual asset IDs before enrollment or arrange an explicitly reviewed follow-up mapping procedure; never invent IDs or recreate the carrier to work around an uncertain result. Creating a carrier is not a substitute for the future permanent client record.

## Privacy and record location

Copy the empty register to a private business folder before entering client data. Suggested location: `03 Carriers/_onboarding-register.csv`, with executed files under `03 Carriers/<carrier>/`. Do not commit a populated register, signatures, W-9s, payment setup URLs, credentials or client documents to this repository. Keep private backups and controlled access. Do not collect bank/card numbers through signatures, email, calls or this register.

The CSV has an initial TEMPORARY comment line; skip that line when importing it into a spreadsheet. Write externally supplied values as text so a leading `=`, `+`, `-` or `@` cannot become a spreadsheet formula. Status columns are independent facts, not interchangeable stages. No example client row is included.

## Handoff to the permanent implementation

The other agent remains responsible for app changes, durable onboarding records, source events, identity resolution, scoped APIs, provisioning and automated status reconciliation. Give it this folder and preserve any private interim record IDs/document IDs during cutover. Removing this bridge must never delete executed client evidence.

No push, deployment, production access, live Stripe operation or email was performed to prepare these assets. Existing live activation permissions are not treated as permission to enroll a new client.

## Regenerating review assets

Run `python3 render-review-html.py` from this folder (or pass its full path), then `node build-review-pdfs.mjs /absolute/path/to/playwright/index.mjs` using an existing local Playwright installation and Chromium. No dependency installation is required by the scripts. HTML rendering has no external assets; PDF rendering blocks external requests. The PDF builder refuses an HTML copy without the review watermark. It does not produce released packets or submit anything to SignWell.

Validation: source hashes matched; agreement and power-of-attorney bodies matched after removing editorial blockquotes; the payment copy contained no full-number entry fields. The combined PDF was rendered and text-extracted page by page, with signature layouts inspected. Provider field placement, account quota, signature delivery, recipient identity, PDF audit download and Stripe completion remain untested external steps.

## Approved release

Owner approval was received November 18, 2026 for the combined packet with the confirmed card and/or ACH wording (v1). The same day the owner confirmed that Iron Wing Logistics L.L.C. has no registered DBA and approved naming the dispatcher only by its legal name (v2): five passages changed (agreement opening and signature table, power-of-attorney opening and signature table, payment-authorization opening), the footer reads "Iron Wing Logistics L.L.C.", and the customer email templates sign with the legal name. On the same day (v3) the owner ordered the power of attorney's signature table `DISPATCH (Agent) | CARRIER` (previously `CARRIER | Accepted by DISPATCH`) to match the agreement and the signing order, in which Iron Wing signs first. **Lawyer confirmation of the v2 and v3 changes is still to be obtained before the first real send.** `build-approved-packet.mjs` verifies the approved source hashes in `approved-release.json` and generates `<stem>.html` and `.pdf` for the stem recorded there; it removes only the visible review watermark and review title/footer. Run it with the same local Playwright path as the review builder. A source change requires review and a new release version rather than silently replacing an approved packet.

This is approval of the packet content and combined format, not evidence of a configured provider template, completed signature test, customer-specific terms or sent request.
