-- Client onboarding (permanent; design §7–§8). Additive only: new tables, indexes and triggers.

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "dba_name" TEXT,
    "mc_number" TEXT,
    "usdot" TEXT,
    "primary_email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ONBOARDING',
    "stripe_customer_id" TEXT,
    "payment_method_id" TEXT,
    "payment_method_type" TEXT,
    "payment_last4" TEXT,
    "payment_brand" TEXT,
    "outreach_party_id" TEXT,
    "kelevo_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_request" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_refs" JSONB NOT NULL,
    "actor" JSONB NOT NULL,
    "terms" JSONB NOT NULL,
    "terms_hash" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "client_id" TEXT NOT NULL,
    "bundle_version_id" TEXT,
    "signature_state" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "signature_code" TEXT,
    "signature_at" TIMESTAMP(3),
    "payment_state" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "payment_code" TEXT,
    "payment_method_type" TEXT,
    "payment_last4" TEXT,
    "payment_at" TIMESTAMP(3),
    "provisioning_state" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "provisioning_code" TEXT,
    "kelevo_ref" TEXT,
    "provisioning_at" TIMESTAMP(3),
    "operations" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_bundle_version" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "files" JSONB NOT NULL,
    "layout" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_bundle_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_envelope" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_document_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'SENDING',
    "last_error_code" TEXT,
    "filled_sha256" TEXT,
    "filled_storage_key" TEXT,
    "completed_sha256" TEXT,
    "completed_storage_key" TEXT,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "superseded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_setup" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "expires_at" TIMESTAMP(3),
    "setup_intent_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'CREATING',
    "last_error_code" TEXT,
    "payment_method_id" TEXT,
    "method_type" TEXT,
    "last4" TEXT,
    "brand" TEXT,
    "emailed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_setup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_event" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_webhook_receipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "receipt_key" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_webhook_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_access_log" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor" JSONB NOT NULL,
    "document" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_usdot_key" ON "client"("usdot");

-- CreateIndex
CREATE UNIQUE INDEX "client_stripe_customer_id_key" ON "client"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_request_idempotency_key_key" ON "onboarding_request"("idempotency_key");

-- CreateIndex
CREATE INDEX "onboarding_request_client_id_idx" ON "onboarding_request"("client_id");

-- CreateIndex
CREATE INDEX "onboarding_request_signature_state_idx" ON "onboarding_request"("signature_state");

-- CreateIndex
CREATE INDEX "onboarding_request_payment_state_idx" ON "onboarding_request"("payment_state");

-- CreateIndex
CREATE UNIQUE INDEX "document_bundle_version_name_version_key" ON "document_bundle_version"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "signature_envelope_provider_document_id_key" ON "signature_envelope"("provider_document_id");

-- CreateIndex
CREATE INDEX "signature_envelope_request_id_idx" ON "signature_envelope"("request_id");

-- CreateIndex
CREATE INDEX "signature_envelope_state_idx" ON "signature_envelope"("state");

-- CreateIndex
CREATE UNIQUE INDEX "payment_setup_checkout_session_id_key" ON "payment_setup"("checkout_session_id");

-- CreateIndex
CREATE INDEX "payment_setup_request_id_idx" ON "payment_setup"("request_id");

-- CreateIndex
CREATE INDEX "payment_setup_state_idx" ON "payment_setup"("state");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_event_event_id_key" ON "onboarding_event"("event_id");

-- CreateIndex
CREATE INDEX "onboarding_event_request_id_version_idx" ON "onboarding_event"("request_id", "version");

-- CreateIndex
CREATE INDEX "onboarding_event_type_delivered_at_next_attempt_at_idx" ON "onboarding_event"("type", "delivered_at", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_webhook_receipt_receipt_key_key" ON "provider_webhook_receipt"("receipt_key");

-- CreateIndex
CREATE INDEX "document_access_log_request_id_idx" ON "document_access_log"("request_id");

-- AddForeignKey
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_envelope" ADD CONSTRAINT "signature_envelope_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_setup" ADD CONSTRAINT "payment_setup_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_event" ADD CONSTRAINT "onboarding_event_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one live envelope per request: a new one may exist only after the
-- previous one is superseded (reissue) or abandoned (draft create failed).
CREATE UNIQUE INDEX "signature_envelope_one_active_per_request"
    ON "signature_envelope" ("request_id")
    WHERE "superseded_by" IS NULL AND "state" <> 'ABANDONED';

-- At most one issuable payment setup per request.
CREATE UNIQUE INDEX "payment_setup_one_open_per_request"
    ON "payment_setup" ("request_id")
    WHERE "state" IN ('CREATING', 'OPEN');

-- Confirmed terms never change after acceptance.
CREATE FUNCTION "onboarding_request_terms_immutable"() RETURNS trigger AS $$
BEGIN
    IF NEW."terms" IS DISTINCT FROM OLD."terms"
        OR NEW."terms_hash" IS DISTINCT FROM OLD."terms_hash"
        OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
        RAISE EXCEPTION 'onboarding_request terms are immutable';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "onboarding_request_terms_immutable"
    BEFORE UPDATE ON "onboarding_request"
    FOR EACH ROW EXECUTE FUNCTION "onboarding_request_terms_immutable"();

-- Approved bundle versions are immutable; only APPROVED -> RETIRED is allowed.
CREATE FUNCTION "document_bundle_version_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'approved document bundle versions cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."status" <> 'DRAFT' AND (
        NEW."name" IS DISTINCT FROM OLD."name"
        OR NEW."version" IS DISTINCT FROM OLD."version"
        OR NEW."files" IS DISTINCT FROM OLD."files"
        OR NEW."layout" IS DISTINCT FROM OLD."layout"
        OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
        OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at") THEN
        RAISE EXCEPTION 'approved document bundle versions are immutable';
    END IF;
    IF (OLD."status" = 'APPROVED' AND NEW."status" NOT IN ('APPROVED', 'RETIRED'))
        OR (OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED') THEN
        RAISE EXCEPTION 'invalid document bundle status change';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "document_bundle_version_guard"
    BEFORE UPDATE OR DELETE ON "document_bundle_version"
    FOR EACH ROW EXECUTE FUNCTION "document_bundle_version_guard"();
