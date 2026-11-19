-- The dispatcher a closer assigned to a carrier (portal load board step).
ALTER TABLE "onboarding_request" ADD COLUMN "dispatcher_name" TEXT;
ALTER TABLE "onboarding_request" ADD COLUMN "dispatcher_email" TEXT;
