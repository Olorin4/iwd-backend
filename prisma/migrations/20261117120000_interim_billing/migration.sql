-- TEMPORARY: interim billing tables. Delete with the feature. See src/interimBilling/DISPOSE.md.

-- CreateTable
CREATE TABLE "interim_billing_carrier" (
    "id" SERIAL NOT NULL,
    "legal_name" TEXT NOT NULL,
    "mc" TEXT,
    "usdot" TEXT,
    "email" TEXT NOT NULL,
    "plan_label" TEXT,
    "fee_bp" INTEGER NOT NULL,
    "stripe_customer_id" TEXT,
    "primary_pm_id" TEXT,
    "primary_pm_brand" TEXT,
    "primary_pm_last4" TEXT,
    "backup_pm_id" TEXT,
    "backup_pm_brand" TEXT,
    "backup_pm_last4" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interim_billing_carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interim_billing_carrier_asset" (
    "id" SERIAL NOT NULL,
    "carrier_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "kelevo_id" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interim_billing_carrier_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interim_billing_run" (
    "id" SERIAL NOT NULL,
    "run_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_invoice_count" INTEGER,
    "approved_total_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interim_billing_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interim_billing_line" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "kelevo_load_id" INTEGER NOT NULL,
    "load_number" INTEGER,
    "kind" TEXT NOT NULL,
    "carrier_id" INTEGER,
    "all_in_rate_cents" INTEGER,
    "linehaul_cents" INTEGER,
    "linehaul_note" TEXT,
    "fee_bp" INTEGER,
    "fee_cents" INTEGER,
    "hold_reason" TEXT,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "invoice_id" INTEGER,
    "stripe_invoice_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interim_billing_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interim_billing_invoice" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "carrier_id" INTEGER NOT NULL,
    "stripe_invoice_id" TEXT,
    "total_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "round" INTEGER NOT NULL DEFAULT 0,
    "tried_backup_this_round" BOOLEAN NOT NULL DEFAULT false,
    "first_failure_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "next_method" TEXT,
    "current_pm_id" TEXT,
    "payment_intent_id" TEXT,
    "last_error_code" TEXT,
    "hosted_invoice_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interim_billing_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interim_billing_stripe_event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interim_billing_stripe_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_carrier_stripe_customer_id_key" ON "interim_billing_carrier"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "interim_billing_carrier_asset_carrier_id_idx" ON "interim_billing_carrier_asset"("carrier_id");

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_carrier_asset_kind_kelevo_id_key" ON "interim_billing_carrier_asset"("kind", "kelevo_id");

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_run_run_end_key" ON "interim_billing_run"("run_end");

-- CreateIndex
CREATE INDEX "interim_billing_line_status_idx" ON "interim_billing_line"("status");

-- CreateIndex
CREATE INDEX "interim_billing_line_run_id_idx" ON "interim_billing_line"("run_id");

-- CreateIndex
CREATE INDEX "interim_billing_line_invoice_id_idx" ON "interim_billing_line"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_line_kelevo_load_id_kind_key" ON "interim_billing_line"("kelevo_load_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_invoice_stripe_invoice_id_key" ON "interim_billing_invoice"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "interim_billing_invoice_status_next_attempt_at_idx" ON "interim_billing_invoice"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "interim_billing_invoice_run_id_carrier_id_key" ON "interim_billing_invoice"("run_id", "carrier_id");

-- AddForeignKey
ALTER TABLE "interim_billing_carrier_asset" ADD CONSTRAINT "interim_billing_carrier_asset_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "interim_billing_carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interim_billing_line" ADD CONSTRAINT "interim_billing_line_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "interim_billing_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interim_billing_line" ADD CONSTRAINT "interim_billing_line_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "interim_billing_carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interim_billing_line" ADD CONSTRAINT "interim_billing_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "interim_billing_invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interim_billing_invoice" ADD CONSTRAINT "interim_billing_invoice_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "interim_billing_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interim_billing_invoice" ADD CONSTRAINT "interim_billing_invoice_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "interim_billing_carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migration-only checks (Prisma does not model them).
ALTER TABLE "interim_billing_carrier"
    ADD CONSTRAINT "interim_billing_carrier_fee_bp_check" CHECK ("fee_bp" BETWEEN 1 AND 3000);
ALTER TABLE "interim_billing_carrier_asset"
    ADD CONSTRAINT "interim_billing_carrier_asset_kind_check" CHECK ("kind" IN ('DRIVER', 'TRUCK'));
ALTER TABLE "interim_billing_line"
    ADD CONSTRAINT "interim_billing_line_kind_check" CHECK ("kind" IN ('DELIVERED', 'CARRIER_CANCELLED')),
    ADD CONSTRAINT "interim_billing_line_cents_check" CHECK (
        COALESCE("all_in_rate_cents", 0) >= 0
        AND COALESCE("linehaul_cents", 0) >= 0
        AND COALESCE("fee_cents", 0) >= 0
    );
ALTER TABLE "interim_billing_invoice"
    ADD CONSTRAINT "interim_billing_invoice_total_check" CHECK ("total_cents" >= 0);
