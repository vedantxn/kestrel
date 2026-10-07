-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "last_version" INTEGER NOT NULL DEFAULT 0;

-- A version number is never given to two writers: start each profile above every version it has had.
UPDATE "profiles" p
   SET "last_version" = GREATEST(
         p."current_version",
         COALESCE((SELECT max(v."version") FROM "profile_versions" v WHERE v."profile_id" = p."id"), 0)
       );
