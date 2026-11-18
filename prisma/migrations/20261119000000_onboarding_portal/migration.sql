-- AlterTable
ALTER TABLE "onboarding_request" ADD COLUMN     "portal_flow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portal_invite_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "portal_invite_claimed_at" TIMESTAMP(3),
ADD COLUMN     "portal_invited_at" TIMESTAMP(3),
ADD COLUMN     "portal_last_opened_at" TIMESTAMP(3),
ADD COLUMN     "purge_after" TIMESTAMP(3),
ADD COLUMN     "purged_at" TIMESTAMP(3),
ADD COLUMN     "ready_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "portal_token" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "portal_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_document" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "uploaded_by" JSONB,
    "storage_key" TEXT,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "media_type" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reject_reason" TEXT,
    "extraction_status" TEXT NOT NULL,
    "extraction_attempts" INTEGER NOT NULL DEFAULT 0,
    "extraction_claimed_at" TIMESTAMP(3),
    "extracted" JSONB,
    "flags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "onboarding_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_questionnaire" (
    "request_id" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_questionnaire_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE INDEX "portal_token_request_id_idx" ON "portal_token"("request_id");

-- CreateIndex
CREATE INDEX "onboarding_document_extraction_status_extraction_claimed_at_idx" ON "onboarding_document"("extraction_status", "extraction_claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_document_request_id_item_key_version_key" ON "onboarding_document"("request_id", "item_key", "version");

-- CreateIndex
CREATE INDEX "onboarding_request_purge_after_purged_at_idx" ON "onboarding_request"("purge_after", "purged_at");

-- AddForeignKey
ALTER TABLE "portal_token" ADD CONSTRAINT "portal_token_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_document" ADD CONSTRAINT "onboarding_document_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_questionnaire" ADD CONSTRAINT "onboarding_questionnaire_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An upload serializes through the parent row. This also protects the
-- current-version invariant against writes outside the application service.
CREATE UNIQUE INDEX "onboarding_document_one_current_per_slot"
ON "onboarding_document" ("request_id", "item_key") WHERE "state" = 'CURRENT';
