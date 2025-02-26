/*
  Warnings:

  - You are about to drop the `ContactSubmission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SignUpForm` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "ContactSubmission";

-- DropTable
DROP TABLE "SignUpForm";

-- CreateTable
CREATE TABLE "sign_up_forms" (
    "id" SERIAL NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fleetSize" TEXT NOT NULL,
    "trailerType" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "submitDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_up_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "message" TEXT NOT NULL,
    "submitDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_up_forms_email_key" ON "sign_up_forms"("email");
