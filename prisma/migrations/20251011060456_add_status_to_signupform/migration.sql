/*
  Warnings:

  - You are about to drop the column `company_id` on the `dispatcher` table. All the data in the column will be lost.
  - The primary key for the `dispatcher_driver` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `first_name` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `last_name` on the `user` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[dispatcher_id,driver_id]` on the table `dispatcher_driver` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id]` on the table `sign_up_form` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `first_name` to the `dispatcher` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_name` to the `dispatcher` table without a default value. This is not possible if the table is not empty.
  - Added the required column `first_name` to the `driver` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_name` to the `driver` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."dispatcher" DROP CONSTRAINT "dispatcher_company_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."driver" DROP CONSTRAINT "driver_company_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."user" DROP CONSTRAINT "user_company_id_fkey";

-- DropIndex
DROP INDEX "public"."dispatcher_company_id_idx";

-- AlterTable
ALTER TABLE "dispatcher" DROP COLUMN "company_id",
ADD COLUMN     "companyId" INTEGER,
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "last_name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "dispatcher_driver" DROP CONSTRAINT "dispatcher_driver_pkey";

-- AlterTable
ALTER TABLE "driver" ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "last_name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sign_up_form" ADD COLUMN     "company_id" INTEGER,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "user_id" INTEGER;

-- AlterTable
ALTER TABLE "user" DROP COLUMN "first_name",
DROP COLUMN "last_name";

-- CreateIndex
CREATE UNIQUE INDEX "dispatcher_driver_dispatcher_id_driver_id_key" ON "dispatcher_driver"("dispatcher_id", "driver_id");

-- CreateIndex
CREATE INDEX "driver_user_id_idx" ON "driver"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sign_up_form_user_id_key" ON "sign_up_form"("user_id");

-- CreateIndex
CREATE INDEX "sign_up_form_company_id_idx" ON "sign_up_form"("company_id");

-- CreateIndex
CREATE INDEX "sign_up_form_user_id_idx" ON "sign_up_form"("user_id");

-- CreateIndex
CREATE INDEX "trailer_company_id_idx" ON "trailer"("company_id");

-- CreateIndex
CREATE INDEX "truck_company_id_idx" ON "truck"("company_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatcher" ADD CONSTRAINT "dispatcher_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_up_form" ADD CONSTRAINT "sign_up_form_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_up_form" ADD CONSTRAINT "sign_up_form_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
