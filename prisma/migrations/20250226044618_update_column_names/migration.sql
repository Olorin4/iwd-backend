/*
  Warnings:

  - You are about to drop the column `submitDate` on the `contact_submissions` table. All the data in the column will be lost.
  - You are about to drop the column `firstName` on the `sign_up_forms` table. All the data in the column will be lost.
  - You are about to drop the column `fleetSize` on the `sign_up_forms` table. All the data in the column will be lost.
  - You are about to drop the column `lastName` on the `sign_up_forms` table. All the data in the column will be lost.
  - You are about to drop the column `submitDate` on the `sign_up_forms` table. All the data in the column will be lost.
  - You are about to drop the column `trailerType` on the `sign_up_forms` table. All the data in the column will be lost.
  - Added the required column `first_name` to the `sign_up_forms` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fleet_size` to the `sign_up_forms` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_name` to the `sign_up_forms` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trailer_type` to the `sign_up_forms` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "contact_submissions" DROP COLUMN "submitDate",
ADD COLUMN     "submit_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "sign_up_forms" DROP COLUMN "firstName",
DROP COLUMN "fleetSize",
DROP COLUMN "lastName",
DROP COLUMN "submitDate",
DROP COLUMN "trailerType",
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "fleet_size" TEXT NOT NULL,
ADD COLUMN     "last_name" TEXT NOT NULL,
ADD COLUMN     "submit_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "trailer_type" TEXT NOT NULL;
