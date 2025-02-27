/*
  Warnings:

  - A unique constraint covering the columns `[message_sid]` on the table `message_logs` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `message_sid` to the `message_logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN     "message_sid" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "message_logs_message_sid_key" ON "message_logs"("message_sid");
