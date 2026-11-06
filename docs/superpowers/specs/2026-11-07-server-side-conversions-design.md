# Server-side conversions — design

Status: proposed, 2026-11-07. Not built. Step 3 of the website attribution roadmap. Reviewed once
by a builder check; its questions are answered below.

## Why

The Iron Wing website (`iron-wing-dispatching.com`) posts three forms to `iwd-backend`:

- sign-up (`POST /sign-up-forms`),
- contact (`POST /contact-forms`),
- newsletter (`POST /newsletter`).

The site already records browser events in PostHog (project 502839, "Iron Wing Dispatching")
through the `relay.iron-wing-dispatching.com` proxy. Outreach's tracked links (step 1, live) bring
visitors with UTM tags and a per-message `ref`, which the site keeps as `outreach_ref` on every
event.

Browser events can still be lost: blocked scripts, closed tabs, failed requests. And Outreach has
no way to learn that a carrier it emailed has engaged, so it keeps sending follow-ups to people who
already signed up.

This step makes `iwd-backend` the reliable record of every form conversion. It does three things:

- sends a server-side PostHog event, linked to the visitor's browser history;
- stores the attribution on its own lead records;
- notifies Outreach straight away, so step 4 can stop or pause that carrier's follow-ups.

## Decisions made with the owner

- **All three forms are recorded, with different weight.** Only a **sign-up is a real
  conversion**. A contact message and a newsletter subscription are weaker signals.
- **What Outreach should do with each form (built in step 4; step 3 sends the signal):**

  | Form | Outreach's action |
  |---|---|
  | Sign-up | Stop all follow-ups and mark the carrier converted |
  | Contact | Pause follow-ups and put the carrier in front of a person, like a reply |
  | Newsletter | Keep the sequence going; just record it |

- **Hand-off from the site:** the forms add two optional fields to the JSON they already post:
  `posthogDistinctId` and `outreachRef`. There are no PostHog tracing headers and no CORS change.
- **`iwd-backend` stores both on its lead records** (SignUpForm, ContactSubmission,
  NewsletterSubscriber).
- **Outreach is notified by a direct webhook.** It fires when the submission has a `ref` **or**
  an email address, so a carrier who comes back on another device can still be matched by email.
  Outreach ignores emails it doesn't know.

## Invariants

- **A visitor's form submission never fails or slows down because of analytics.** PostHog and the
  webhook run after the lead is saved and the response is sent. Their errors are logged, never
  returned to the visitor.
- **Turnstile verification, validation and rate limiting stay exactly as they are,** and run
  first. Nothing is captured or sent for a submission that fails them.
- **The new fields are untrusted input.** Both are optional and validated:
  - `outreachRef` must match `/^[a-z2-7]{12}$/`;
  - `posthogDistinctId` must be a string of at most 200 characters.

  Anything else is dropped, not rejected, so a malformed field never blocks a lead.
- **Brands stay separate.** These are Iron Wing leads. The PostHog token is project 502839's, and
  the webhook payload says `brand: "IRON_WING"`.
- **Minimum personal data.** PostHog gets no names, phone numbers or message text. It gets the
  email only as the identity the website already uses (`identifyVisitor` sets the person's email).
  The webhook carries only what Outreach needs to match and act on the lead.

## PostHog events (server-side)

Send them with `posthog-node` from `iwd-backend`. The token comes from a new optional env var,
`POSTHOG_PROJECT_TOKEN`; without it, capture is a no-op. The host is the PostHog ingestion host
(`https://us.i.posthog.com`); server traffic does not need the ad-blocker relay.

| Form | Event | `conversion_tier` | Extra properties |
|---|---|---|---|
| Sign-up | `lead_signed_up` | `primary` | `plan`, `fleet_size` (number or null), `trailer_type`, `has_phone` |
| Contact | `contact_requested` | `secondary` | `has_phone` |
| Newsletter | `newsletter_subscribed_server` | `secondary` | — |

Every event also carries:

- `outreach_ref`, when present;
- `form`: `"sign_up"`, `"contact"` or `"newsletter"`;
- `source: "server"`;
- `deployment_environment`: `"production"`, or `"development"` when `NODE_ENV !== "production"`.

**The identity email (builder-check call).** Use the address **as the visitor typed it, trimmed
and lowercased**. This is the same rule as the website's `identifyVisitor` and as Outreach's
`normalizeEmail`, so both PostHog and Outreach can match it.

- The existing sanitizers (`normalizeEmail()` in `sanitizeSignUpForm` / `sanitizeContactForm`)
  strip Gmail dots and `+tags` and rewrite `googlemail.com`. So capture the address **before**
  they run, for example into `res.locals.identityEmail` in a small middleware placed ahead of the
  sanitizers.
- What is stored in the lead row stays as it is today (sanitized). Only PostHog and the webhook use
  the identity email.

**Identity (builder-check call).** Every server event uses the identity email as `distinctId`, with
`$set: { email }`.

- When `posthogDistinctId` is present and differs from that email, first send a merge, so the
  visitor's anonymous browser history joins the email person even if the browser's own `identify`
  was blocked or failed.
- The merge is a posthog-node `$identify` capture with `distinctId: email` and
  `properties: { $anon_distinct_id: posthogDistinctId }`.
- PostHog refuses to merge two already-identified people. That case is harmless: the event still
  lands on the email person.

**Naming against the browser events.** The site already sends `sign_up_form_submitted`,
`contact_form_submitted` and `newsletter_subscribed` from the browser. The server events have
distinct names, so neither set double-counts the other. The newsletter event is suffixed `_server`
because `newsletter_subscribed` is taken. The browser events stay as they are. PostHog funnels and
the A/B test use the server events as their goals.

## Storage (one additive Prisma migration in iwd-backend)

Add two nullable columns to `SignUpForm`, `ContactSubmission` and `NewsletterSubscriber`:
`outreachRef String?` and `posthogDistinctId String?`. No backfill. The admin listing endpoints
(`GET /sign-up-forms`, `GET /contact-forms`) return them as part of each row.

## Webhook to Outreach

- **Target:** Outreach's private listener on the shared Docker `edge` network. Use
  `OUTREACH_CONVERSION_WEBHOOK_URL` (for example `http://outreach:3012/internal/webhooks/conversions`)
  and `OUTREACH_WEBHOOK_TOKEN`, sent as `Authorization: Bearer <token>`.
  - This is the same model as Outreach's existing OpenMagpie webhook: private port, rotated
    bearer token, never public.
  - If either variable is unset, the webhook is disabled. Disabled is the state until step 4 ships
    the endpoint.
- **When:** after the lead is saved, if the submission has an `outreachRef` or an email. Fire and
  forget relative to the visitor's response.
- **Repeat newsletter subscriptions (builder-check call):** when the address is already subscribed
  (Prisma `P2002`), do nothing new. No PostHog event, no webhook, and the existing row is left
  untouched. The visitor still gets today's 200.
  - This matches the owner's weighting: the newsletter is the weakest signal, and Outreach only
    records it.
  - Sign-up and contact always create a new row, so they always fire.
- **Body (JSON):**

  ```json
  {
    "event_id": "<uuid, unique per submission>",
    "type": "sign_up" | "contact" | "newsletter",
    "brand": "IRON_WING",
    "outreach_ref": "<12-char ref or null>",
    "email": "<lowercased email>",
    "occurred_at": "<ISO timestamp>",
    "lead_id": <id of the saved row>
  }
  ```

- **Retries:** up to 3 attempts with backoff (about 1 s, 5 s, 30 s), only on network errors and 5xx
  responses. A 2xx or 4xx is final. A 4xx is logged with its status, because it means a
  configuration or contract problem, not a temporary one.
  - Retries live in memory. A restart during the retry window loses the remaining attempts. That is
    acceptable because the lead row stores the ref and email, so step 4 could reconcile from
    `iwd-backend` later if it ever needs to.
- **Idempotency:** `event_id` lets Outreach drop duplicates caused by retries. Step 4 must dedupe on
  it.

## Website side (iron-wing-dispatching repo)

The three form handlers add both fields to the JSON body they already post:

- `outreachRef`: the registered `outreach_ref` super property (`posthog.get_property`);
- `posthogDistinctId`: `posthog.get_distinct_id()`.

Expose these from `src/analytics.js` as small helpers that return `null` while analytics is off.
The forms send `null` or omit the fields in that case.

## Delivery notes (builder-check calls)

- **Ship order:**
  - `contactForm` passes `req.body` straight to Prisma, so the backend (migration plus code) must
    be live before the website starts sending the new fields.
  - The website change ships second.
  - Until both are live, the backend accepts and ignores missing fields.
- **CI/CD:** add `POSTHOG_PROJECT_TOKEN`, `OUTREACH_CONVERSION_WEBHOOK_URL` and
  `OUTREACH_WEBHOOK_TOKEN` to the `.env` the deploy workflow writes, as optional values. Leave the
  two webhook values unset until step 4.
- **Shutdown:** flush posthog-node on SIGTERM / SIGINT so a deploy restart doesn't drop queued
  events.
- **PostHog configuration is out of scope.** Pointing funnels or the A/B test at the new events
  belongs to the experiment step, not this one.

## Non-goals

- The Outreach endpoint itself, matching emails and refs to contacts, and acting on follow-ups
  (step 4).
- Changing Turnstile, validation, rate limits, notification emails or the admin token.
- Dashboards (step 5).
- Re-sending or reconciling leads saved before this ships.

## Anti-goals (failure even if it "works")

- A carrier's sign-up returning an error or hanging because PostHog or Outreach is down.
- A lead counted twice as a conversion (browser plus server under the same event name).
- Personal data such as name, phone or message text sent to PostHog.
- The webhook reachable from the public internet, or sent without its token.

## Tests the builder should include

- Each form: a valid submission saves the two fields and captures the right event with the right
  `distinctId`, `conversion_tier` and properties. With PostHog unconfigured, it still succeeds and
  sends nothing.
- Invalid `outreachRef` or `posthogDistinctId` values are dropped, and the lead is still saved.
- PostHog throwing, or the webhook failing or timing out, does not change the visitor's response.
- Webhook: sent with a ref and also with only an email; skipped when disabled; retried on 5xx and
  network errors; not retried on 4xx; the bearer token is present; `event_id` is unique per
  submission.
- A Turnstile failure or a validation error captures nothing and sends nothing.

## Left to the builder

- Where the PostHog client and webhook sender live, and their module names.
- Exact backoff timings within the stated bounds.
- Log wording.
- How the site's form scripts read the two values, as long as they come from `src/analytics.js`.
