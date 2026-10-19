-- Up Migration
-- 통합순7 웹 푸시 대기열. 수업 시간·밤에는 deliver_after까지 보류했다가 보낸다.
-- 결과 수는 "푸시 서비스가 받음"이지 학생이 봤다는 뜻이 아니다(공통 계약 1).
CREATE TABLE push_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 발송 직전에 이 반의 승인된 구성원인지 다시 확인한다(반을 나간 학생에게 보내지 않음).
  class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,
  tag VARCHAR(64) NOT NULL,
  title VARCHAR(80) NOT NULL,
  body VARCHAR(200) NOT NULL,
  path VARCHAR(200) NOT NULL,
  deliver_after TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT push_deliveries_kind_check CHECK (kind IN ('reminder', 'schedule_changed')),
  CONSTRAINT push_deliveries_status_check CHECK (status IN ('pending', 'done')),
  CONSTRAINT push_deliveries_path_check CHECK (path LIKE '/%' AND path NOT LIKE '//%'),
  CONSTRAINT push_deliveries_counts_check CHECK (
    accepted_count >= 0 AND failed_count >= 0 AND removed_count >= 0
  ),
  CONSTRAINT push_deliveries_completed_check CHECK (
    (status = 'pending' AND completed_at IS NULL) OR (status = 'done' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX push_deliveries_due_index ON push_deliveries(status, deliver_after);
CREATE INDEX push_deliveries_user_tag_index ON push_deliveries(user_id, tag, status);
REVOKE ALL ON push_deliveries FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON push_deliveries TO classhub_app;
GRANT UPDATE (status, accepted_count, failed_count, removed_count, completed_at)
  ON push_deliveries TO classhub_app;

-- Down Migration
-- 대기열은 다시 만들 수 있는 발송 작업이라 보존 대상 기록이 아니다.
REVOKE ALL ON push_deliveries FROM classhub_app;
DROP TABLE push_deliveries;
