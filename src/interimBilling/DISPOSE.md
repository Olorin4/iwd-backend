<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Disposal procedure

Run this only after KelevoTMS agency billing replaces this module. These are
instructions for a future approved removal, not commands applied by this build.
Production SSH artifacts have **not been applied**.

1. Disable `INTERIM_BILLING_AUTO_RUN`, then `INTERIM_BILLING_ENABLED`. Stop the
   worker. Reconcile pending ACH results, failed invoices, disputes and credits
   with the replacement billing ledger before switching collection ownership.
2. Export all six `interim_billing_*` tables to an access-controlled archive
   according to the business retention policy. Keep Stripe statement and
   authorization records needed for accounting and disputes. Verify the export.
3. Remove `src/interimBilling/` and `__tests__/interimBilling/`.
4. Remove all the hooks below. References are line numbers at implementation;
   the listed code anchors are authoritative if later edits shift them.
5. Add a **new** migration using the SQL below; never edit or delete a migration
   already deployed. Remove the model block, generate Prisma, and test before
   applying that migration during the approved replacement release.
6. Remove the module settings and CI secrets, endpoint and SSH access described
   below. Retest sign-up, contact, newsletter and lead administration.

## Six hook groups

| Group                 | File and exact starting line                  | Remove                                                                                                                 |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Router                | `src/router.js:22`, `:26`                     | Marked import and `router.use("/interim-billing", interimBillingRouter)`                                               |
| App                   | `src/app.js:9`, `:21`, `:55`                  | Marked import, `verify: interimBillingRawBody` (restore `express.json()`), `void startInterimBilling()`                |
| Dependency and models | `package.json:42`; `prisma/schema.prisma:267` | `stripe` dependency (regenerate `package-lock.json`), marked block with the six InterimBilling models through line 393 |
| SSH runtime           | `Dockerfile:6`; `docker-compose.yml:23`       | `openssh-client` only from apt packages; marked read-only `/run/interim-billing:ro` volume                             |
| CI env                | `.github/workflows/ci-cd-pipeline.yml:108`    | Marked `INTERIM_BILLING_*`, `STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY` lines in Generate .env file          |
| Test setup            | `__tests__/setup-integration.js:25`           | Marked comment and `if (expect.getState().testPath?.includes("interimBilling")) return;` guard                         |

## Drop migration to add at disposal time

After the verified export, put this in a newly timestamped
`prisma/migrations/<timestamp>_drop_interim_billing/migration.sql`:

```sql
BEGIN;
DROP TABLE "interim_billing_line";
DROP TABLE "interim_billing_invoice";
DROP TABLE "interim_billing_carrier_asset";
DROP TABLE "interim_billing_run";
DROP TABLE "interim_billing_carrier";
DROP TABLE "interim_billing_stripe_event";
COMMIT;
```

No `CASCADE`: an unexpected dependency must stop the removal.

## Settings and external resources

Remove the following settings from runtime and secrets of the same names from CI:

```text
INTERIM_BILLING_ENABLED
INTERIM_BILLING_MODE
INTERIM_BILLING_LIVE_CONFIRM
INTERIM_BILLING_TIMEZONE
INTERIM_BILLING_RUN_HOUR
INTERIM_BILLING_START_DATE
INTERIM_BILLING_AUTO_RUN
INTERIM_BILLING_KELEVO_SSH_HOST
INTERIM_BILLING_KELEVO_SSH_USER
INTERIM_BILLING_KELEVO_SSH_KEY_FILE
INTERIM_BILLING_KELEVO_SSH_KNOWN_HOSTS_FILE
INTERIM_BILLING_LOADS_FILE
INTERIM_BILLING_STRIPE_WEBHOOK_SECRET
INTERIM_BILLING_PRODUCT_ID
INTERIM_BILLING_ADMIN_EMAIL
INTERIM_BILLING_ADMIN_TOKEN
STRIPE_SANDBOX_SECRET_KEY
STRIPE_LIVE_SECRET_KEY
```

In each Stripe mode used, remove the webhook endpoint whose URL ends with
`/interim-billing/webhook`, revoke module-specific API keys, and archive the
Dispatch fee product only if the replacement does not use it. Do not delete
customers, statements or saved mandates merely because the module is removed.
The build used no live Stripe key.

If the production artifacts were later applied, obtain owner approval and
remove them on **kelevo-prod**. The following commands are a removal template,
not executed instructions. Check the installed names first:

```sh
# Remove this dedicated user's authorized key (only if user is module-exclusive).
sudo rm -f /home/iwdbilling/.ssh/authorized_keys
sudo rm -f /etc/sudoers.d/iwd-interim-billing
sudo rm -f /opt/iwd-interim-billing/export-loads.sh
sudo rmdir /opt/iwd-interim-billing
```

Using the approved production database connection and database name:

```sql
REVOKE EXECUTE ON FUNCTION public.iwd_billing_loads(timestamptz, timestamptz) FROM iwd_billing_ro;
DROP FUNCTION public.iwd_billing_loads(timestamptz, timestamptz);
DROP OWNED BY iwd_billing_ro;
DROP ROLE iwd_billing_ro;
```

`DROP OWNED` removes this dedicated role's grants in the current database;
verify it owns nothing unrelated before running it. Remove the dedicated OS
user with `sudo userdel iwdbilling` only after confirming it is unused.
On Hetzner remove the module's private key and known-hosts file from
`/home/nick-kalas/apps/interim-billing-secrets/`, then remove the empty folder.
Do not remove unrelated keys or edit KelevoTMS tables.
