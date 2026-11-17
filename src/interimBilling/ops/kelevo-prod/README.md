<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Restricted production reader templates

The owner approved installation on 2026-11-17. Rendered copies are now applied
and verified; see [INSTALLATION.md](INSTALLATION.md) for the exact scope,
placeholders, hashes, public fingerprints and access-control test results.
These source files remain generic templates with preparation-time comments;
do not reapply them blindly (the SQL intentionally creates a fresh role).

What gets created, once, additively and without restarting anything:

1. `01-iwd_billing_loads.sql`: a login `iwd_billing_ro` that can only execute
   one read-only function returning Iron Wing's loads (fill in the
   organization id first).
2. `export-loads.sh`: the forced command. Copy to
   `/opt/iwd-interim-billing/export-loads.sh`, owned by root, mode 0755, with
   the real database name replacing `__KELEVO_DB_NAME__`.
3. A dedicated unprivileged user `iwdbilling` (not in the docker group) with
   `sudoers.example` installed and `authorized_keys.example` as its only key.
4. On the Hetzner host: the private key and a known-hosts file pinning
   `kelevo-prod`, mounted read-only into the container.

Disposal is in `../../DISPOSE.md`.
