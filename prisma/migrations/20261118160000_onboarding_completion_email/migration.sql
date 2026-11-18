-- R15: one combined email at signature completion (signed copy + payment
-- link + documents list). Additive: two nullable columns.
-- completion_emailed_at is the atomic exactly-once claim for that email;
-- documents_requested_at records when it went out (reminders count from it).
ALTER TABLE "onboarding_request" ADD COLUMN "completion_emailed_at" TIMESTAMP(3);
ALTER TABLE "onboarding_request" ADD COLUMN "documents_requested_at" TIMESTAMP(3);

-- Requests that already received the old payment-link email never get the
-- combined email retroactively (and, with documents_requested_at left null,
-- no reminders either).
UPDATE "onboarding_request" r
SET "completion_emailed_at" = (
    SELECT MIN(ps."emailed_at") FROM "payment_setup" ps
    WHERE ps."request_id" = r."id" AND ps."emailed_at" IS NOT NULL
)
WHERE EXISTS (
    SELECT 1 FROM "payment_setup" ps
    WHERE ps."request_id" = r."id" AND ps."emailed_at" IS NOT NULL
);
