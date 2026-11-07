-- AlterTable
ALTER TABLE "sign_up_form" ADD COLUMN "outreach_ref" TEXT;
ALTER TABLE "sign_up_form" ADD COLUMN "posthog_distinct_id" TEXT;
ALTER TABLE "contact_submission" ADD COLUMN "outreach_ref" TEXT;
ALTER TABLE "contact_submission" ADD COLUMN "posthog_distinct_id" TEXT;
ALTER TABLE "newsletter_subscriber" ADD COLUMN "outreach_ref" TEXT;
ALTER TABLE "newsletter_subscriber" ADD COLUMN "posthog_distinct_id" TEXT;
