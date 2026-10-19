-- Up Migration
-- T-HELP-CHAT(2026-09-27 사용자 결정): 도움 요청을 학생과 담임의 자유 대화로 넓힌다.
-- 기존 요청의 설명(message)·답변(reply)은 그대로 둔다(자료 변환 없음). 이후 말은 help_request_messages에 쌓는다.
-- 학생은 공지·준비물에서, 또는 글과 무관하게(kind='general') 대화를 시작한다. 글과 무관한 대화는 학생마다 열린 것 1개.
-- 닫힌 대화(resolved)는 다시 열 수 있다(열림으로 돌아가도 예전 답변은 남는다).
ALTER TABLE help_requests DROP CONSTRAINT help_requests_open_unique;
ALTER TABLE help_requests DROP COLUMN open_target;
ALTER TABLE help_requests ADD COLUMN open_target TEXT GENERATED ALWAYS AS (
  CASE
    WHEN status = 'open' THEN
      CASE
        WHEN notice_id IS NOT NULL THEN 'n' || notice_id
        WHEN supply_id IS NOT NULL THEN 's' || supply_id
        ELSE 'g'
      END
    ELSE NULL
  END
) STORED;
ALTER TABLE help_requests ADD CONSTRAINT help_requests_open_unique UNIQUE (member_id, open_target);
ALTER TABLE help_requests ADD CONSTRAINT help_requests_id_class_unique UNIQUE (id, class_id);
ALTER TABLE help_requests DROP CONSTRAINT help_requests_target_check;
ALTER TABLE help_requests DROP CONSTRAINT help_requests_kind_check;
ALTER TABLE help_requests DROP CONSTRAINT help_requests_closed_check;
ALTER TABLE help_requests ADD CONSTRAINT help_requests_target_v2_check CHECK (
  (kind = 'general' AND num_nonnulls(notice_id, supply_id) = 0)
  OR (kind <> 'general' AND num_nonnulls(notice_id, supply_id) = 1)
);
ALTER TABLE help_requests ADD CONSTRAINT help_requests_kind_v2_check
  CHECK (kind IN ('question', 'hard_to_prepare', 'general'));
ALTER TABLE help_requests ADD CONSTRAINT help_requests_closed_v2_check CHECK (
  (status = 'open' AND closed_at IS NULL)
  OR (status = 'resolved' AND closed_at IS NOT NULL)
  OR (status = 'withdrawn' AND closed_at IS NOT NULL AND reply IS NULL)
);

-- 주고받은 말은 고치거나 지우지 않는다(교권 보호·분쟁 대비 기록).
CREATE TABLE help_request_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  help_request_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  author_member_id BIGINT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT help_request_messages_request_fk FOREIGN KEY (help_request_id, class_id)
    REFERENCES help_requests (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_request_messages_author_fk FOREIGN KEY (author_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_request_messages_body_check CHECK (char_length(body) BETWEEN 1 AND 500)
);
CREATE INDEX help_request_messages_request_index ON help_request_messages(help_request_id, id);

REVOKE ALL ON help_request_messages FROM PUBLIC;
GRANT SELECT, INSERT ON help_request_messages TO classhub_app;

ALTER TABLE push_deliveries DROP CONSTRAINT push_deliveries_kind_check;
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_kind_v2_check
  CHECK (kind IN ('reminder', 'schedule_changed', 'help_message'));

-- Down Migration
-- 대화 내용은 학생 개인 사정이 담길 수 있어 되돌릴 때 함께 지운다. 글과 무관한 대화도 지워야 옛 제약이 선다.
ALTER TABLE push_deliveries DROP CONSTRAINT push_deliveries_kind_v2_check;
DELETE FROM push_deliveries WHERE kind = 'help_message';
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_kind_check
  CHECK (kind IN ('reminder', 'schedule_changed'));
REVOKE ALL ON help_request_messages FROM classhub_app;
DROP TABLE help_request_messages;
DELETE FROM help_requests WHERE kind = 'general';
ALTER TABLE help_requests DROP CONSTRAINT help_requests_closed_v2_check;
ALTER TABLE help_requests DROP CONSTRAINT help_requests_kind_v2_check;
ALTER TABLE help_requests DROP CONSTRAINT help_requests_target_v2_check;
ALTER TABLE help_requests DROP CONSTRAINT help_requests_id_class_unique;
UPDATE help_requests SET reply = NULL WHERE status = 'open';
ALTER TABLE help_requests ADD CONSTRAINT help_requests_target_check CHECK (num_nonnulls(notice_id, supply_id) = 1);
ALTER TABLE help_requests ADD CONSTRAINT help_requests_kind_check CHECK (kind IN ('question', 'hard_to_prepare'));
ALTER TABLE help_requests ADD CONSTRAINT help_requests_closed_check CHECK (
  (status = 'open' AND closed_at IS NULL AND reply IS NULL)
  OR (status = 'resolved' AND closed_at IS NOT NULL)
  OR (status = 'withdrawn' AND closed_at IS NOT NULL AND reply IS NULL)
);
ALTER TABLE help_requests DROP CONSTRAINT help_requests_open_unique;
ALTER TABLE help_requests DROP COLUMN open_target;
ALTER TABLE help_requests ADD COLUMN open_target TEXT GENERATED ALWAYS AS (
  CASE
    WHEN status = 'open' THEN
      CASE WHEN notice_id IS NOT NULL THEN 'n' || notice_id ELSE 's' || supply_id END
    ELSE NULL
  END
) STORED;
ALTER TABLE help_requests ADD CONSTRAINT help_requests_open_unique UNIQUE (member_id, open_target);
