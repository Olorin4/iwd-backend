<!-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md. -->

# Interim weekly billing (TEMPORARY)

This folder bills Iron Wing carriers every Friday through Stripe. It exists
only until the dispatching-agency billing feature in KelevoTMS is live, and
**the whole folder is then deleted** (see `DISPOSE.md`).

- Design: `docs/superpowers/specs/2026-11-17-interim-weekly-billing-design.md`
- Plan: `docs/superpowers/plans/2026-11-17-interim-weekly-billing.md`
- Off unless `INTERIM_BILLING_ENABLED=true`. Sandbox first: see `SANDBOX-TEST.md`.
- Money moves only after a person approves a run.
