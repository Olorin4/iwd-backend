/*
  Warnings:

  - You are about to drop the column `email` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `first_name` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `full_name` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `last_name` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `middle_name` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `drivers` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[user_id]` on the table `drivers` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "drivers_email_key";

-- DropIndex
DROP INDEX "drivers_phone_key";

-- AlterTable
ALTER TABLE "drivers" DROP COLUMN "email",
DROP COLUMN "first_name",
DROP COLUMN "full_name",
DROP COLUMN "last_name",
DROP COLUMN "middle_name",
DROP COLUMN "phone",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "user_id" INTEGER;

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
