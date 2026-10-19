-- Review-only: runtimeActivationApplied=false, realMariaDbVerified=false.
-- Use the new exact app_profile_photos_v1 grant profile only after applying this delta.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.user_profile_photos TO 'classhub_app'@'%';
GRANT UPDATE (photo_version, image_bytes, updated_at)
  ON classhub_mariadb_phase1_dev.user_profile_photos TO 'classhub_app'@'%';
