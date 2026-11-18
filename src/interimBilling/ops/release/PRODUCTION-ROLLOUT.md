<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Production rollout proposal — 2026-11-17

Status: the owner approved the disabled release, which is now deployed. See the
[execution record](DEPLOYMENT-2026-11-17.md) for applied changes and remaining
admin-key cleanup (subsequently deferred by the owner). Carrier onboarding and
collection require separate authorization. Manual activation was subsequently
approved and verified; see the [activation record](ACTIVATION-2026-11-18.md). The owner selected **2026-11-23** as the initial billing start
date. Initial operation uses manually created runs, with automatic Friday run
creation off and explicit approval of every invoice count and total.

## Current checks

These were refreshed with read-only requests on 2026-11-17:

| Check                              | Result                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Live account                       | `acct_1UcfhXLodvRQZljj`; charges enabled; card and ACH capabilities active                    |
| Existing live v1 webhook endpoints | Complete listing returned 0                                                                   |
| GitHub repository billing secrets  | No `INTERIM_BILLING_*`, `STRIPE_LIVE_SECRET_KEY` or `STRIPE_SANDBOX_SECRET_KEY` names present |
| Local credentials                  | Restricted live key saved locally; no live billing flags configured                           |
| Hetzner backend                    | Running; started `2026-11-17T06:23:58.276444659Z`                                             |
| Public HTTPS                       | Backend root returned 200; undeployed billing webhook path returned 404 on GET                |
| Current image                      | `sha256:bbcc4d8937e424ce2e23eb6bd8c44c3db79b063413e936e50b407289a680de84`                     |
| Production billing environment     | No billing settings present; feature disabled by default                                      |
| Production schema                  | No `interim_billing_*` tables; latest completed migration `20261107120000_lead_attribution`   |
| Reader files on Hetzner            | Dedicated private key present, mode 0600; host pin present, mode 0644; contents not read      |
| Reader mount in running container  | Absent; branch Compose adds the read-only mount at deployment                                 |

The [sandbox results](../../SANDBOX-RESULTS.md) and
[email previews](../../EMAIL-PREVIEWS.md) cover the application behavior.
The existing [reader installation](../kelevo-prod/INSTALLATION.md) is already
approved and installed; this rollout does not reapply or change Kelevo SQL,
SSH users, keys or grants. No SSH session to `kelevo-prod` was needed for this
readiness check. Production inspection read schema names only, not business rows.

## Exact configuration

The CI workflow rebuilds the server environment file from repository Actions
secrets, so persistent settings must be configured there before the respective
release. Secret values must move directly between approved runtimes/secret stores,
never through chat, logs, command arguments, documentation or version control.

| Setting                                       | Disabled release                                              | Manual live operation                             |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `INTERIM_BILLING_ENABLED`                     | `false`                                                       | `true`, only after activation approval            |
| `INTERIM_BILLING_MODE`                        | `live`                                                        | `live`                                            |
| `INTERIM_BILLING_LIVE_CONFIRM`                | `yes`                                                         | `yes`                                             |
| `INTERIM_BILLING_AUTO_RUN`                    | `false`                                                       | `false`                                           |
| `INTERIM_BILLING_TIMEZONE`                    | `America/Chicago`                                             | Same                                              |
| `INTERIM_BILLING_RUN_HOUR`                    | `6`                                                           | Same; unused while automatic creation is off      |
| `INTERIM_BILLING_START_DATE`                  | `2026-11-23`                                                  | Same                                              |
| `INTERIM_BILLING_PRODUCT_ID`                  | `prod_VdynnoKRWNRS3t`                                         | Same                                              |
| `INTERIM_BILLING_ADMIN_EMAIL`                 | `info@iron-wing-dispatching.com`                              | Same                                              |
| `INTERIM_BILLING_KELEVO_SSH_HOST`             | `100.65.207.113`                                              | Same                                              |
| `INTERIM_BILLING_KELEVO_SSH_USER`             | `iwdbilling`                                                  | Same                                              |
| `INTERIM_BILLING_KELEVO_SSH_KEY_FILE`         | `/run/interim-billing/id_ed25519`                             | Same                                              |
| `INTERIM_BILLING_KELEVO_SSH_KNOWN_HOSTS_FILE` | `/run/interim-billing/known_hosts`                            | Same                                              |
| `INTERIM_BILLING_ADMIN_TOKEN`                 | New random 32-byte hex token, separate from `ADMIN_API_TOKEN` | Same private value                                |
| `STRIPE_LIVE_SECRET_KEY`                      | Saved restricted live key, transferred only with approval     | Same private value                                |
| `INTERIM_BILLING_STRIPE_WEBHOOK_SECRET`       | Unset until the endpoint is created                           | That endpoint's private signing secret            |
| `INTERIM_BILLING_LOADS_FILE`                  | Unset                                                         | Unset; fixtures are forbidden in live mode        |
| `STRIPE_SANDBOX_SECRET_KEY`                   | Unset                                                         | Unset; never copy sandbox carriers or ledger rows |

The start setting is an inclusive **UTC** lower bound:
`2026-11-23T00:00:00Z`. Weekly cutoffs use America/Chicago, so this is not local
midnight. Review the actual load dates and each carrier's agreed effective date
before approving the initial draft. The first complete Monday–Sunday period
starting November 23 ends November 29; its normal Friday charge date is
**December 4, 2026**. November 27 is not the charge date for that complete week.

## Exact live webhook proposal

Register a snapshot endpoint for **this account**, not Connect accounts. The
handler expects v1 snapshot event names and refetches current Stripe objects.
The request body for `POST /v1/webhook_endpoints` is:

```json
{
    "url": "https://api.iron-wing-dispatching.com/interim-billing/webhook",
    "api_version": "2026-10-28.endive",
    "connect": false,
    "enabled_events": [
        "setup_intent.succeeded",
        "invoice.paid",
        "invoice.payment_failed",
        "invoice.finalized",
        "charge.dispute.created"
    ]
}
```

Do not submit this request until approved. Check for an existing exact URL first
to avoid duplicate endpoints. Pin the account identity before any write. Capture
the create response's signing secret directly into the approved secret store,
without printing the response. If the endpoint already exists but its signing
secret is unavailable, stop and arrange a deliberate secret rotation instead of
silently creating another endpoint. Refetch only nonsecret endpoint metadata to
verify account mode, URL, API version and five event subscriptions.

The [Stripe endpoint API](https://docs.stripe.com/api/webhook_endpoints/create)
documents the creation parameters. The endpoint secret is distinct from a CLI
listener secret and from an API key. The handler returns 503 when work must be
retried; retain [Stripe delivery retries](https://docs.stripe.com/webhooks), which
are separate from the disabled **payment** retries.

## Proposed execution order after approval

1. **Rotate the previously exposed deployment SSH key.** Generate its replacement
   outside any source/build context. Add only its public half to the existing
   deployment user's access, verify it works, update `SSH_PRIVATE_AWS_SERVER_KEY`
   directly, then revoke the positively identified old public key. Preserve all
   unrelated SSH access. The old public fingerprint must be established before
   revocation; the 2026-11-17 image cleanup did not rotate the credential.
2. **Set the disabled-release configuration.** Generate the dedicated admin token
   without displaying it; place it in GitHub Actions and the owner's approved
   private storage. Transfer the saved restricted live key only with explicit
   authorization. Keep `ENABLED=false` and `AUTO_RUN=false`. Verify stored secret
   names, not values. The local restricted key's read checks do not establish
   its runtime write permissions. Confirm permission scope in Stripe before
   activation: Customers and Checkout Sessions write; Invoices and Invoice Items
   write; SetupIntents, PaymentMethods, PaymentIntents, Charges and Disputes read.
   Review inline-price creation permissions as needed. Webhook creation needs a
   separate authorized management permission if the runtime key lacks it; do not
   broaden runtime permissions just to provision a webhook.
3. **Preserve rollback and release the code disabled.** Record the current image
   and retain a rollback tag before CI rebuild/prune. With separate push/merge
   approval, merge the feature branch and push `master`. The existing workflow
   automatically runs tests, rebuilds the image and recreates the backend.
   Container startup applies `20261117120000_interim_billing`, which creates six
   new tables/indexes/constraints; it does not rewrite existing business tables.
   Verify the release commit/source signature and completed migration, read-only
   key mount, backend health, existing public forms and disabled billing routes.
   Do not dump `docker compose config`, full inspect output or environment files.
4. **Create and configure the approved live webhook.** Use the exact proposal
   above and save its signing secret directly into Actions secrets. The disabled
   handler returns 404 until activation; no live onboarding/invoicing is allowed
   during this short setup window. If another enabled endpoint already exists,
   preserve it until its purpose is understood. Do not use Stripe CLI's default
   account authentication, which pointed at a different account during sandbox
   work.
5. **Review activation separately.** Reconfirm Stripe automatic payment retries
   are off and customer email controls match the desired behavior. These
   Dashboard-only controls were reported configured in the owner handoff, not
   refreshed by the API reads above. Validate the complete live config without
   printing secrets; ensure the new production ledger is empty. Only after the
   activation approval, set `ENABLED=true`, keep `AUTO_RUN=false`, and rerun
   the approved master deployment workflow to regenerate its environment and
   recreate the backend (the workflow has no manual dispatch trigger). Record
   that workflow run id after the disabled release; updating secrets alone does
   not update a running container. Verify missing admin token gives
   401 and an unsigned webhook gives 400; never log the bearer token. The worker
   runs recovery/retries for approved runs even when automatic creation is off.
6. **Onboard the real carrier deliberately.** Use its actual agreement, fee basis
   points, asset ids and effective date; send a live hosted setup link only with
   authorization to contact that carrier. Complete card/bank verification and
   verify the real signed webhook saved the method. First inspect a dry run,
   confirm linehaul and cancellation decisions, then build/review the draft.
   Creating a non-dry run creates live Stripe drafts and sends summaries.
   Approval of the exact count/total starts real collection and needs the
   owner's run-specific approval. No synthetic production carrier or live test
   charge is part of this rollout.

## Rollback

Before the first live collection, disable `INTERIM_BILLING_ENABLED` in Actions
and the active runtime, stop/recreate the worker, and restore the retained known
working backend image if needed. Keep the additive billing tables; do not drop
or roll back an applied migration to undo an application release. Confirm public
forms still work. Keep the replacement deployment credential so the exposed key
is not restored.

After any live debit is pending, coordinate rollback with statement/payment
reconciliation first. Fully disabling the module also stops signed event
handling and retry/recovery; retain the endpoint and arrange event redelivery
when service returns. Never resume collection from a copied sandbox database.
