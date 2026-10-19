-- Prepared profile-photo storage; runtimeActivationApplied=false, realMariaDbVerified=false.
-- Approval and exact runtime ACL attestation are required before operating DB installation.
CREATE TABLE user_profile_photos (
  user_id BIGINT NOT NULL,
  photo_version CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  image_bytes VARBINARY(64000) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (user_id),
  CONSTRAINT user_profile_photos_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_profile_photos_size_check CHECK (OCTET_LENGTH(image_bytes) BETWEEN 1 AND 64000),
  CONSTRAINT user_profile_photos_version_check CHECK (photo_version REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
