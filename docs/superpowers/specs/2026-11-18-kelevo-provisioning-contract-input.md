# Kelevo agency-client provisioning: contract input for PRD-0020

Status: **PROPOSAL — not approved.** Input from the iwd-backend onboarding
implementation (2026-11-18) to Kelevo PRD-0020. Ruling R1: no Kelevo schema
change in this programme; iwd-backend uses a manual adapter until PRD-0020
defines and ships an API. Nothing here is implemented on the Kelevo side.

## Why iwd-backend needs it

After a carrier signs and saves a payment method, Iron Wing must set the
carrier up as an agency client in Kelevo (company, fleet, dispatcher access).
Today an operator does this by hand and records the Kelevo reference with
`confirm_provisioning`. An API would remove the manual step and let
iwd-backend verify the result.

## Proposed principles

- **Stable external id:** iwd-backend's `Client.id` (UUID). Kelevo stores it as
  an external reference, unique per agency.
- **Idempotent create:** repeating a create with the same external id returns
  the existing record (200) instead of creating a second one; conflicting
  identity data returns 409 with a code.
- **Scoped credential:** a dedicated token that can only create/read agency
  clients for the Iron Wing agency; no load, billing or user-admin access.
- **No documents:** signed PDFs, W-9s and insurance stay in iwd-backend.
- **No payment data:** Stripe ids and payment methods stay in iwd-backend.

## Proposed endpoints

`PUT /api/agency/clients/{external_id}`

```json
{
    "legal_name": "Example Freight LLC",
    "dba_name": null,
    "mc_number": "MC123456",
    "usdot": "1234567",
    "primary_contact": {
        "name": "Sam Example",
        "title": "Owner",
        "email": "owner@example.test"
    },
    "service": {
        "plan": "FULL_SERVICE",
        "fee_bp": 1000,
        "effective_date": "2026-11-30"
    },
    "truck_count": 2
}
```

Responses: `201 { "kelevo_ref": "...", "status": "PENDING_SETUP|ACTIVE" }` new;
`200` same external id and same identity; `409 { "code": "usdot_conflict" }`
when another client already holds the USDOT; `422` invalid.

`GET /api/agency/clients/{external_id}` → `{ kelevo_ref, status, fleet: { trucks, drivers }, updated_at }`
so iwd-backend can reconcile after a timeout.

## What iwd-backend would do

- Adapter `kelevo` replaces the stub: `PUT` with `Client.id`; 201/200 →
  provisioning `SUCCEEDED` with `kelevo_ref`; timeout → `GET` before retrying;
  4xx → `FAILED` with the code (operator `retry_provisioning`).
- Fleet mapping remains an operator-verified checklist item until Kelevo
  exposes fleet data that iwd-backend can check.

## Open questions for PRD-0020

1. Does an agency client exist before fleet assets are known?
2. Which Kelevo user(s) get dispatcher access, and who approves that?
3. Should Kelevo notify iwd-backend (webhook) when the client becomes active?
4. How are identity corrections (legal name, MC) handled after creation?
