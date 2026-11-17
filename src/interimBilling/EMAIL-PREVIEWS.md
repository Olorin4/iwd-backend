<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Billing email previews

Synthetic examples generated from the same formatters used by the billing services.
No emails were sent to create these previews. Example links are placeholders.
The existing shared business signature is appended by the email service.

## Admin: approval required

Subject: Action required: approve dispatch billing run 12

```text
ADMIN ONLY — dispatch billing approval
Run: 12
Week ending: Sunday, November 15, 2026 (America/Chicago)
Earlier unbilled loads may also be included.

Invoices: 1
Total to approve: $240.00 USD
No payment is started for this run until you approve it.

CARRIER TOTALS
- Example Carrier LLC (carrier 7): 3 loads, $240.00 USD

HELD LOADS: 2
- Load ID 91002 (line 101): Missing linehaul — enter the linehaul amount excluding fuel and extras.
  All-in rate (reference only): $1,900.00.
- Load ID 91003 (line 102): Cancellation needs review — confirm whether the carrier cancelled after accepting.
Undated cancellations excluded: 1
Undated cancellations cannot be billed; review and correct the source date first.

NEXT STEPS
Review the run and held loads through the billing admin API. Enter missing linehaul and decide who cancelled each cancelled load. Refresh the draft after changes and review the new summary.
When the totals match your review, approve run 12 with invoice count 1 and total 24000 cents ($240.00 USD). Use the latest summary; an older total will be rejected.
Fees apply to linehaul only, excluding fuel surcharge and accessorials.
```

## Carrier: primary setup

Subject: Set up dispatch fee payments

```text
Save your primary payment method securely with Stripe:
https://example.com/stripe-setup

Nothing is charged during setup. Your payment details are collected by Stripe. This is the first payment method we will use for your weekly dispatch fees.

If you choose a bank account, complete any bank verification requested by Stripe. Setup is complete only after Stripe confirms verification.

Questions? Contact info@iron-wing-dispatching.com.
```

## Carrier: backup setup

Subject: Set up dispatch fee payments

```text
Save your backup payment method securely with Stripe:
https://example.com/stripe-setup

Nothing is charged during setup. Your payment details are collected by Stripe. Your backup is used only if your primary payment is declined or returned.

If you choose a bank account, complete any bank verification requested by Stripe. Setup is complete only after Stripe confirms verification.

Questions? Contact info@iron-wing-dispatching.com.
```

## Carrier: weekly statement

Subject: Your weekly dispatch statement

```text
Your Iron Wing Dispatching statement is ready.
Dispatch fees: $240.00 USD

View your itemized statement: https://example.com/statement
Download the invoice PDF: https://example.com/invoice.pdf

We will charge your saved primary payment method. If it is declined or returned, we may use your saved backup. This email is a statement, not confirmation of payment; bank debits may take time to process.
Fees apply only to linehaul and are owed regardless of factoring or broker payment.
Questions or corrections? Contact info@iron-wing-dispatching.com within 14 days of this statement.
```

## Admin: final payment failure

Subject: Action required: dispatch invoice 42 remains unpaid

```text
ADMIN ONLY — payment review required
Invoice: 42 | Carrier: 7
Dispatch fees: $240.00 USD
The configured payment attempts are exhausted. No further automatic collection will be attempted. Contact the carrier to resolve payment; review before deciding whether to pause new bookings.
Statement: https://example.com/statement
```

## Carrier: final payment failure

Subject: Dispatch payment unsuccessful

```text
Payment for your dispatch statement of $240.00 USD remains unsuccessful after our scheduled attempts.

No further automatic payment attempt is scheduled for this statement.

Please contact info@iron-wing-dispatching.com to arrange payment. New bookings may be paused until payment is resolved.

View your statement: https://example.com/statement
```

## Admin: returned payment after paid

Subject: Billing alert: returned payment for dispatch invoice 42

```text
ADMIN ONLY — payment review required
Invoice: 42 | Carrier: 7
Dispatch fees: $240.00 USD
Stripe reports a payment failure after this invoice was marked paid. No further automatic collection will be attempted. Review the payment in Stripe before taking action.
Statement: https://example.com/statement
```

## Admin: dispute

Subject: Billing alert: dispatch payment disputed

```text
ADMIN ONLY — a dispatch payment has been disputed.

Dispute reference: dp_example
Review the dispute and response deadline in Stripe. No automatic retry is triggered by this dispute.
```
