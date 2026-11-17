<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Disabled production release — 2026-11-17

The owner approved configuring CI secrets and the live webhook, rotating the
exposed deployment credential, and merging/pushing/deploying with billing
**disabled**. Live activation, carrier contact and real collection were not
included. The selected start date remains `2026-11-23`; automatic run creation
is off. The [rollout proposal](PRODUCTION-ROLLOUT.md) describes the stages.

## Release and verification

- Feature branch fast-forwarded into `master` and pushed at `9ef8ecc`.
- Initial [CI run 44110518107](https://github.com/Olorin4/iwd-backend/actions/runs/44110518107)
  failed before deployment: fresh-runner tests could not import
  `.prisma/client/default`. Production was unchanged by that failed run.
- Commit `1e538e9` explicitly generates the Prisma client before tests. Local
  generation plus the full suite passed 302/302. The repaired
  [CI run 44111080462](https://github.com/Olorin4/iwd-backend/actions/runs/44111080462)
  passed both test and build/deploy jobs and deployed that commit.
- Container started at `2026-11-17T15:11:53.185335948Z`, image
  `sha256:ced86918f24decdf547c511db8faea0e1803c766d9d3843477dfcf9f3c65f2c8`.
- Hashes of 38 deployed module/application/migration/package files matched the
  release checkout before this subsequent documentation update.
- Migration `20261117120000_interim_billing` completed, with no rollback marker.
  All six billing tables exist and contain **zero rows**. Verification read
  counts and schema metadata, not production business records.
- Runtime flags: `ENABLED=false`, `MODE=live`, `AUTO_RUN=false`,
  `START_DATE=2026-11-23`. Both the restricted live key and separate billing admin
  token are configured. Enabling the module was not attempted.
- Reader directory is mounted read-only at `/run/interim-billing`; the key is
  mode 0600 and the host pin is 0644. SSH client is installed. No Kelevo SQL,
  grants or server configuration changed during this release.
- Public health returned 200. Billing admin and webhook requests returned 404
  as intended while disabled. Empty sign-up/contact/newsletter submissions
  returned 403 at the existing bot guard, without creating records or emails.
  These rejection checks do not claim a real visitor submission was delivered.
- Known sensitive files `/app/private_key.pem`, `/app/.env` and `/app/.env.test`
  are absent from the image. Secrets were never printed.

Rollback image retained as `iwd-backend:before-interim-20261117`, pointing at
`sha256:bbcc4d8937e424ce2e23eb6bd8c44c3db79b063413e936e50b407289a680de84`.
The normal dangling-image cleanup preserves this tagged image. Retain the
additive schema if rolling the application back.

## Secrets and live webhook

The approved disabled profile is stored in repository Actions secrets, including
a freshly generated 32-byte hex admin token that differs from the lead-listing
admin token. Private recovery storage on Hetzner is outside the source/build
context under `~/.local/share/iwd-billing/`, directory 0700, secret files 0600.
No secret contents appear in this record. The sandbox key and fixture-load
setting were not configured for production.

Live account identity was pinned to `acct_1UcfhXLodvRQZljj` before the endpoint
write. A complete endpoint listing was checked to prevent duplicate registration.

| Field               | Verified value                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Endpoint            | `we_1Uco4NLodvRQZljjDMXtemfY`                                                                                     |
| URL                 | `https://api.iron-wing-dispatching.com/interim-billing/webhook`                                                   |
| Account mode/status | Live; enabled                                                                                                     |
| API version         | `2026-10-28.endive`                                                                                               |
| Payload/scope       | v1 snapshot events; this account, not Connect                                                                     |
| Events              | `setup_intent.succeeded`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `charge.dispute.created` |

The signing secret was transferred directly from the create response to private
Hetzner storage and `INTERIM_BILLING_STRIPE_WEBHOOK_SECRET` in Actions. It was
created **after** the disabled deployment, following the approved stage order.
The running disabled container therefore does not yet have the signing secret;
the next approved deployment regenerates its environment from Actions. The live
profile was validated in memory against the deployed code with that secret,
without changing the actual disabled runtime flag. No live event delivery to an
active handler has been claimed: its current HTTP response is deliberately 404.

API read checks and webhook creation do not prove all runtime invoice-write
permissions. Review those scopes and the Dashboard-only payment-retry/email
settings before activation, as described in the proposal.

## Deployment key rotation status

The GitHub CI credential now uses a dedicated iwd-backend ED25519 key. Its public
half was installed with `restrict`; a new-key-only connection succeeded before
`SSH_PRIVATE_AWS_SERVER_KEY` was updated. The successful CI deployment also used
that replacement. The private key was transferred directly into Actions and
never entered a checkout, image, tool output or chat.

New CI fingerprint:

```text
SHA256:jLKGnfYSYO35e74X+1Rzmo+8/eboKt76jL2aDgn7x6c
```

SSH authentication records showed that the exposed **old CI key was the same
key as the current local Hetzner admin connection**, fingerprint:

```text
SHA256:STVGaXb7dYMyTMlj4yMHUiEw3P0UIbF8qrbbOUeKs+Y
```

That old public authorization remains in place pending the owner's answer about
replacing local admin access too. Do not report full revocation as complete.
An unrelated pre-existing deployment public key was preserved. Removal must
match the exposed fingerprint, never delete the whole authorized-keys file or
revoke the other deployment key.

## Next approval boundary

Billing remains disabled. Before enabling manual live operation, resolve the
admin-key replacement, review restricted-key permissions and Dashboard settings,
and use a separately approved deployment to set `ENABLED=true` while keeping
`AUTO_RUN=false`. Real carrier setup emails require authorization to contact that
carrier; each run's exact invoice count and total must be approved before any
charge. No real or synthetic carrier, draft invoice, payment method or charge
was created in the live account by this rollout; its only Stripe write was the
approved webhook endpoint registration.
