-- Up Migration
-- Prepared profile-photo storage. Do not apply to an operating database without rollout approval.
-- Only sanitized 256px WebP bytes are stored; originals and file names are never persisted.
CREATE TABLE user_profile_photos (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  photo_version UUID NOT NULL,
  image_bytes BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_profile_photos_size_check CHECK (octet_length(image_bytes) BETWEEN 1 AND 64000)
);
REVOKE ALL ON user_profile_photos FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON user_profile_photos TO classhub_app;
GRANT UPDATE (photo_version, image_bytes, updated_at) ON user_profile_photos TO classhub_app;

-- Down Migration
-- Destructive rollback: first disable photo routes and export/backup this table if photos must be kept.
-- Prefer code/route rollback while retaining the table and deletion cleanup; do not run this automatically.
REVOKE ALL ON user_profile_photos FROM classhub_app;
DROP TABLE user_profile_photos;
