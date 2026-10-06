-- 媒体重处理中心：批量修复缺失缩略图 / 波形 / 时长

-- CreateEnum
CREATE TYPE "RepairType" AS ENUM ('thumbnail', 'waveform', 'duration');

-- CreateEnum
CREATE TYPE "RepairBatchStatus" AS ENUM ('running', 'done', 'failed', 'partial');

-- AlterEnum：新增「仅探测时长」的任务类型
ALTER TYPE "JobType" ADD VALUE 'media_duration';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "batch_id" TEXT;

-- CreateTable
CREATE TABLE "repair_batches" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "repairs" "RepairType"[] NOT NULL,
    "status" "RepairBatchStatus" NOT NULL DEFAULT 'running',
    "total_targets" INTEGER NOT NULL DEFAULT 0,
    "total_jobs" INTEGER NOT NULL DEFAULT 0,
    "succeeded_targets" INTEGER NOT NULL DEFAULT 0,
    "failed_targets" INTEGER NOT NULL DEFAULT 0,
    "estimated_bytes" BIGINT NOT NULL DEFAULT 0,
    "actual_bytes" BIGINT NOT NULL DEFAULT 0,
    "source_missing" INTEGER NOT NULL DEFAULT 0,
    "targets" JSONB NOT NULL,
    "failures" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "repair_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_batches_family_id_fingerprint_key" ON "repair_batches"("family_id", "fingerprint");

-- CreateIndex
CREATE INDEX "repair_batches_family_id_status_idx" ON "repair_batches"("family_id", "status");

-- CreateIndex
CREATE INDEX "jobs_batch_id_idx" ON "jobs"("batch_id");

-- AddForeignKey
ALTER TABLE "jobs"
ADD CONSTRAINT "jobs_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "repair_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
