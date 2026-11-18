-- R15 follow-up: split "claimed" from "sent" so a crash between the claim and
-- the SMTP call is retried instead of losing the email. Additive.
-- completion_emailed_at now means "SMTP accepted"; the claim moves to
-- completion_email_claimed_at. Stale claims (> 30 min) are re-claimed, at most
-- 3 attempts; then completion_email_code = 'completion_email_failed' (BLOCKED,
-- action reconcile). Reminders get the same claim/attempts pair.
ALTER TABLE "onboarding_request" ADD COLUMN "completion_email_claimed_at" TIMESTAMP(3);
ALTER TABLE "onboarding_request" ADD COLUMN "completion_email_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "onboarding_request" ADD COLUMN "completion_email_code" TEXT;
ALTER TABLE "onboarding_request" ADD COLUMN "reminder_claimed_at" TIMESTAMP(3);
ALTER TABLE "onboarding_request" ADD COLUMN "reminder_attempts" INTEGER NOT NULL DEFAULT 0;

-- Rows already marked (backfill of 20261118160000, or sent under the earlier
-- single-column claim) count as sent with one attempt.
UPDATE "onboarding_request"
SET "completion_email_claimed_at" = "completion_emailed_at",
    "completion_email_attempts" = 1
WHERE "completion_emailed_at" IS NOT NULL;
