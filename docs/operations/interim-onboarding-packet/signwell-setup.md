<!-- TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately. -->

# SignWell manual template setup

Checked against official documentation November 18, 2026. This is a documented procedure; no SignWell account session, template upload, field configuration or send was performed.

## Account and template

The [current pricing page](https://www.signwell.com/pricing/) lists the Free dashboard plan as one sender, one template and three documents per month. Free does not include template links or attachment requests. API quota and dashboard quota are separate questions; do not assume an older “25 free API documents” statement establishes the dashboard allowance or this account's available quota.

Use one combined PDF/template to avoid depending on multi-template merging. Confirm actual quota/account limits and how the combined file is counted in the dashboard before sending. No paid upgrade or account creation is authorized here.

After the payment-form adaptation is approved and a released PDF exists:

1. In **Templates**, select **New Template** and upload the released combined packet.
2. Create placeholders **Carrier** and **Dispatch**, assigning fields to the correct placeholder. See [template instructions](https://help.signwell.com/article/246-creating-using-and-deleting-a-template).
3. Add fields using the map below. Make required signatures, names/titles and dates required. Prefill confirmed commercial values before sending and verify they cannot be changed unexpectedly; test the actual account/editor's field behavior. If it cannot lock a fee/plan field, prefill the PDF text outside the provider for that carrier before sending.
4. Use **Finish Template** and save. Use **Use Template** for each request, rather than a public reusable signing link.
5. Set **Carrier first, Dispatch second** so the carrier signs, then the authorized Iron Wing representative countersigns. Preview the actual order/notifications in the account. See [send settings](https://help.signwell.com/article/261-using-the-features-in-the-send-modal).
6. Insert the custom message from `email-copy.md`. Check recipients and all populated values. Leave automated reminders off initially to avoid multiple unexpected emails.
7. Test one complete signing cycle with explicitly approved internal recipients, then download the final PDF and audit evidence. Confirm all three documents, initials/checkboxes and commercial values survived. A manual dashboard test can consume quota and send real email; API test mode is a distinct workflow, not an assumed dashboard switch.

## Field map

| Document                     | Field ownership and placement                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agreement opening            | Dispatcher-confirmed effective date, carrier legal name, MC, USDOT.                                                                                                                |
| Agreement Section 4          | Exactly one agreed plan. Fleet selection requires agreed percentage and service plan; leave no ambiguous multiple selections.                                                      |
| Agreement signatures         | Dispatch company/contact/signature/date; Carrier company/contact/signature/date.                                                                                                   |
| Power of attorney opening    | Effective date, carrier legal name and MC, matching agreement.                                                                                                                     |
| Power of attorney signatures | Carrier company, name/title, signature/date; Dispatch company, name/title, signature/date.                                                                                         |
| Payment opening and fee      | Carrier signer/legal name/MC, matching plan and percentage.                                                                                                                        |
| Payment method choices       | Carrier confirms card/ACH/both, one primary if both, and agreed starting date. Use required-choice controls only where supported; otherwise review manually before countersigning. |
| Payment signature            | Carrier signature, authorization date and statement email.                                                                                                                         |

No full payment-number fields, file uploads or account credentials belong in this template. Keep the three underlying forms separate in the private executed-record archive if useful, but preserve the provider's complete executed packet/audit original.

## Stop conditions

If a customer declines, an email address is wrong, a fee changes or a request expires, resolve that specific request using the provider's documented controls. Never alter an executed packet. Keep the old document ID/status and explicitly version any replacement; do not assume clicking Send again is idempotent.

The API [embedded example](https://developers.signwell.com/reference/create-a-document) demonstrates `test_mode: true`; it does not prove the dashboard can send sandbox emails or that this account has been configured. No API integration is needed for this interim manual process.
