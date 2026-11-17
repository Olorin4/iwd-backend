<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Approved restricted reader installation — 2026-11-17

The owner approved the production SQL/script, real organization/database
placeholders and dedicated key pair in the follow-up after the branch review.
The approved reader artifacts have now been installed and tested. This did
**not** deploy or enable the interim billing application, change business data,
restart KelevoTMS, or authorize live Stripe collection.

## Installed scope

- Target: `kelevo-prod`, Tailscale `100.65.207.113`.
- Container/database: `postgres-prod` / `kelevo_tms_db_prod`.
- Fixed organization: `3` (Iron Wing Logistics L.L.C., verified in the DB).
- Database role `iwd_billing_ro`: LOGIN, connection limit 2, 20-second statement
  timeout; no superuser, create-role, create-database or replication privilege.
- One SECURITY DEFINER function:
  `public.iwd_billing_loads(timestamptz,timestamptz)`, fixed organization scope,
  fixed search_path and UTC time zone, public execution revoked.
- Dedicated OS user `iwdbilling`, its own group only, not the Docker group.
- Root-owned script `/opt/iwd-interim-billing/export-loads.sh` mode 0755.
- Root-owned `/etc/sudoers.d/iwd-interim-billing` mode 0440; exact script only;
  preserves `SSH_ORIGINAL_COMMAND` for validation. `visudo` validation passed.
- User-owned `.ssh` directory mode 0700 and `authorized_keys` mode 0600.
  Public key is forced to `sudo -n /opt/iwd-interim-billing/export-loads.sh`,
  with `restrict`, `no-pty`, and source address `100.126.12.97`.

The production copies were rendered from the repository templates, changing
only the organization/database placeholders and the public key/source address.
Template comments saying NOT APPLIED describe the initial preparation; this
installation record is authoritative for their current external state.

## Client key and host pin

Client: `hetzner-staging`, Tailscale `100.126.12.97`.

Files in `/home/nick-kalas/apps/interim-billing-secrets/`:

- `id_ed25519`: generated on Hetzner, mode 0600. The private half was never
  printed, fetched, or transferred to another host.
- `id_ed25519.pub`: dedicated public half.
- `known_hosts`: pins Kelevo's actual public ED25519 host key, read over the
  existing trusted SSH connection; no trust-on-first-use scan was used.

Public fingerprints:

```text
reader: SHA256:48lWqG63cm2YE0l3qUiSOheXvGo/3qIy0VDDIpSLFWo
server: SHA256:8pU7HqzaHEoWhIw/0PzPY4yPV7itzulwKpVqg8MSK1E
```

Settings for a future separately approved application release:

```text
INTERIM_BILLING_KELEVO_SSH_HOST=100.65.207.113
INTERIM_BILLING_KELEVO_SSH_USER=iwdbilling
INTERIM_BILLING_KELEVO_SSH_KEY_FILE=/run/interim-billing/id_ed25519
INTERIM_BILLING_KELEVO_SSH_KNOWN_HOSTS_FILE=/run/interim-billing/known_hosts
```

The planned read-only volume makes these container paths available after the
feature branch is deployed. No server environment file, CI secret, application
image or active Compose configuration was changed during this installation.

## Verification

- Actual dedicated-key read from Hetzner with strict host pinning succeeded.
  Window: `[2026-11-01T00:00:00Z, 2026-11-16T06:00:00Z)`.
  JSON response was an array, **0 rows** for the current billing scope.
- An additional historical validation window `[2026-08-01, 2026-09-01)` passed
  through the actual `fetchLoads`/`parseLoadRows` code via Hetzner's restricted
  key: **1 PAID row** validated. This was a reader contract check, not a billing
  run. No source rows were printed or persisted to workspace files.
- `id` and a timestamp window with appended `; id` were rejected, exit 2,
  without command output.
- A deliberately wrong PUBLIC host pin was rejected, exit 255.
- Direct SSH TCP forwarding was rejected as administratively prohibited.
- No other public SECURITY DEFINER function is executable by this role.
- Direct table SELECT was denied to `iwd_billing_ro`; load-table SELECT,
  INSERT, UPDATE and DELETE privileges all false; public-table write grants 0.
- Installed script and sudoers passed syntax validation before installation.
- Kelevo API remained running with start time 2026-11-16T12:12:16Z;
  application processes were not restarted by these operations.

Rendered artifact SHA-256 values:

```text
SQL          12cd3f00b12e1d7da0b8f98eb06810294ca048cad87241ebd5760ec4086be0e7
script       02896e84222a868e03f0692f1ef81eb00cf42debcde0acc317c186a47e4329fe
sudoers      533ce8e6d0a70e7f226c2d987a39f036d1a4d8fa4db72d771f2d3cdcedbb090b
authorized   79f18833e0ed6fefd34537773d7d95aacb723029aa29ae2e27d0b5b725ba18ef
known_hosts  ce81fa098b9ee55605498ace06610b5bee0a9827b2c2029de18b453ddaa14dd8
```

Use [the disposal guide](../../DISPOSE.md) to remove this access when the module
is retired. Production reader installation and live billing activation remain
separate actions.
