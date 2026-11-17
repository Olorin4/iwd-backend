<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Production artifacts for kelevo-prod (NOT APPLIED)

**NOT APPLIED. Requires the owner's approval of the exact text before anything
here is run on `kelevo-prod`.** These files are written and tested locally only.

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
