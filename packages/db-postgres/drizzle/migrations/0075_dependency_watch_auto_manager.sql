ALTER TABLE "dependency_watches"
  ALTER COLUMN "manifest_path" SET DEFAULT 'auto';

ALTER TABLE "dependency_watches"
  ALTER COLUMN "lockfile_path" SET DEFAULT 'auto';
