-- 媒体重处理中心：批量修复缺失缩略图 / 波形 / 时长
-- 新 JobType 取值只能用 ALTER TYPE ADD VALUE 追加（PG12+ 允许在事务里添加，
-- 但同事务内不可使用新值——本迁移没有 DDL 引用它们，运行时才使用，安全）。
ALTER TYPE "JobType" ADD VALUE 'media_repair_dispatch';
ALTER TYPE "JobType" ADD VALUE 'media_repair_image';
ALTER TYPE "JobType" ADD VALUE 'media_repair_audio';

-- CreateEnum
CREATE TYPE "RepairScope" AS ENUM ('missing', 'failed', 'all');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('scanning', 'queued', 'running', 'done', 'done_with_errors', 'failed');

-- CreateEnum
CREATE TYPE "RepairItemStatus" AS ENUM ('pending', 'running', 'done', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "RepairArtifact" AS ENUM ('thumb', 'large', 'waveform', 'transcode', 'duration');

-- CreateTable
CREATE TABLE "media_repair_runs" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "scope" "RepairScope" NOT NULL DEFAULT 'missing',
    "status" "RunStatus" NOT NULL DEFAULT 'scanning',
    "verify_on_disk" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "bytes_estimate" BIGINT NOT NULL DEFAULT 0,
    "bytes_actual" BIGINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_repair_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_repair_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "job_id" TEXT,
    "artifacts" "RepairArtifact"[] NOT NULL,
    "status" "RepairItemStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "bytes_estimate" BIGINT NOT NULL DEFAULT 0,
    "bytes_actual" BIGINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_repair_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_repair_runs_family_id_created_at_idx" ON "media_repair_runs"("family_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_repair_items_run_id_media_id_key" ON "media_repair_items"("run_id", "media_id");

-- CreateIndex
CREATE INDEX "media_repair_items_run_id_status_idx" ON "media_repair_items"("run_id", "status");

-- CreateIndex
CREATE INDEX "media_repair_items_media_id_idx" ON "media_repair_items"("media_id");

-- AddForeignKey
ALTER TABLE "media_repair_runs" ADD CONSTRAINT "media_repair_runs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_repair_items" ADD CONSTRAINT "media_repair_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "media_repair_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
