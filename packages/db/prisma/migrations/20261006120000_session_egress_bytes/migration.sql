-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "egress_bytes_down" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "egress_bytes_up" BIGINT NOT NULL DEFAULT 0;
