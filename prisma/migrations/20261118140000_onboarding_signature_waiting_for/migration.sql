-- R14: who the open packet is waiting for (onboarding.status.v1
-- signature.waiting_for). Additive: one nullable column, no backfill.
ALTER TABLE "onboarding_request" ADD COLUMN "signature_waiting_for" TEXT;
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_signature_waiting_for_check"
    CHECK ("signature_waiting_for" IS NULL OR "signature_waiting_for" IN ('IRON_WING', 'CARRIER'));
