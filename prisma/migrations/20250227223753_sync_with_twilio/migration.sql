/*
  Warnings:

  - You are about to drop the column `from` on the `call_logs` table. All the data in the column will be lost.
  - You are about to drop the column `to` on the `call_logs` table. All the data in the column will be lost.
  - You are about to drop the column `from` on the `message_logs` table. All the data in the column will be lost.
  - You are about to drop the column `to` on the `message_logs` table. All the data in the column will be lost.
  - Added the required column `from_number` to the `call_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `to_number` to the `call_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `from_number` to the `message_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `to_number` to the `message_logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "call_logs" DROP COLUMN "from",
DROP COLUMN "to",
ADD COLUMN     "from_number" TEXT NOT NULL,
ADD COLUMN     "to_number" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "message_logs" DROP COLUMN "from",
DROP COLUMN "to",
ADD COLUMN     "from_number" TEXT NOT NULL,
ADD COLUMN     "to_number" TEXT NOT NULL;
