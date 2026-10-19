-- 통합순7 웹 푸시 대기열. 수업 시간·밤에는 deliver_after까지 보류했다가 보낸다.
CREATE TABLE push_deliveries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tag VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(80) NOT NULL,
  body VARCHAR(200) NOT NULL,
  path VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deliver_after DATETIME(6) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  accepted_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  removed_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  completed_at DATETIME(6),
  PRIMARY KEY (id),
  CONSTRAINT push_deliveries_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT push_deliveries_class_fk FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE,
  CONSTRAINT push_deliveries_kind_check CHECK (kind IN ('reminder', 'schedule_changed')),
  CONSTRAINT push_deliveries_status_check CHECK (status IN ('pending', 'done')),
  CONSTRAINT push_deliveries_path_check CHECK (path LIKE '/%' AND path NOT LIKE '//%'),
  CONSTRAINT push_deliveries_counts_check CHECK (
    accepted_count >= 0 AND failed_count >= 0 AND removed_count >= 0
  ),
  CONSTRAINT push_deliveries_completed_check CHECK (
    (status = 'pending' AND completed_at IS NULL) OR (status = 'done' AND completed_at IS NOT NULL)
  ),
  INDEX push_deliveries_due_index (status, deliver_after),
  INDEX push_deliveries_user_tag_index (user_id, tag, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
