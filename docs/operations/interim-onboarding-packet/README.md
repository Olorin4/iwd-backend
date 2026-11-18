<!-- TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately. -->

# Interim dispatcher onboarding packet

Prepared November 18, 2026. **Local review assets only: nothing has been uploaded, sent, signed or provisioned.** This bridge does not change Jack, Outreach, billing code or Kelevo and is not a competing onboarding implementation.

## Contents and release status

- `combined-packet.pdf`: all three documents for one reusable signature template. Separate PDFs and HTML previews are also provided.
- Agreement and limited power of attorney: substantive source wording preserved. Editorial DRAFT/provenance blockquotes omitted from customer copies, based on the owner's report that lawyer review was completed November 17. The source folder's README and draft labels have not been updated.
- Payment authorization: **proposed Stripe-only collection adaptation; owner approval required before release.** It removes full card/account/routing fields, replaces them with a Stripe-only instruction, and removes the old editorial handling note. The charge authorization, commercial terms and revocation text are preserved. See `payment-form-changes.md`.
- All PDFs are marked **REVIEW COPY — NOT FOR SIGNING** until that adaptation and final field placement are reviewed. They are ordinary PDFs for signature-provider field overlays, not interactive AcroForms or configured SignWell templates.
- `dispatcher-checklist.md`, `email-copy.md`, `signwell-setup.md` and `register-template.csv`: operating assets.
- `source-manifest.json`: hashes of original Markdown files; the originals remain untouched.

## Fast manual path

1. Confirm the closing details using the checklist. A Jack summary alone is insufficient.
2. After owner approval of the payment-form adaptation, generate an unwatermarked release copy from the reviewed files. Retain a version/hash; do not overwrite a sent version.
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
