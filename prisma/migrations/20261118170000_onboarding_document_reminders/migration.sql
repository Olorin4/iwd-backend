-- R15: documents reminders (onboarding.status.v1 operations.reminders_sent,
-- operations.reminders_paused). Additive: two columns with defaults. Checklist
-- item states (PENDING/RECEIVED/VERIFIED) live in the existing "operations"
-- JSON column; no change needed there.
ALTER TABLE "onboarding_request" ADD COLUMN "reminders_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "onboarding_request" ADD COLUMN "reminders_paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_reminders_sent_check"
    CHECK ("reminders_sent" >= 0 AND "reminders_sent" <= 2);
