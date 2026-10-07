-- AlterEnum
ALTER TYPE "end_reason" ADD VALUE 'profile_unavailable';

-- AlterTable
ALTER TABLE "nodes" ADD COLUMN     "chrome_major" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "warm_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "max_profile_bytes" BIGINT NOT NULL DEFAULT 5368709120,
ADD COLUMN     "max_profiles" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "profile_id" UUID;

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "writer_session_id" UUID,
    "writer_since" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_versions" (
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "bytes" BIGINT,
    "sha256" TEXT,
    "chrome_major" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "committed_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "profile_versions_pkey" PRIMARY KEY ("profile_id","version")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_writer_session_id_key" ON "profiles"("writer_session_id");

-- CreateIndex
CREATE INDEX "profiles_project_id_created_at_id_idx" ON "profiles"("project_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "profile_versions_state_superseded_at_idx" ON "profile_versions"("state", "superseded_at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A version is pending (its writer runs), committed (current) or superseded (kept for readers, then collected).
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_state_check" CHECK ("state" IN ('pending', 'committed', 'superseded'));

-- Names are unique among a project's live profiles (Prisma cannot express a partial index).
CREATE UNIQUE INDEX "profiles_project_id_name_live_key" ON "profiles"("project_id", "name") WHERE "deleted_at" IS NULL AND "name" IS NOT NULL;
