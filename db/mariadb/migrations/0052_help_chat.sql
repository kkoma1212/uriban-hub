-- T-HELP-CHAT(2026-09-27 사용자 결정): 도움 요청을 학생과 담임의 자유 대화로 넓힌다.
-- 원장 번호는 84·85로 교사 자료함(0051, 86·87)보다 먼저 적용한다(파일 번호와 순서가 다름).
-- 기존 요청의 설명(message)·답변(reply)은 그대로 둔다(자료 변환 없음). 이후 말은 help_request_messages에 쌓는다.
-- 학생은 공지·준비물에서, 또는 글과 무관하게(kind='general') 대화를 시작한다. 글과 무관한 대화는 학생마다 열린 것 1개.
-- 닫힌 대화(resolved)는 다시 열 수 있다(열림으로 돌아가도 예전 답변은 남는다).
ALTER TABLE help_requests
  DROP CONSTRAINT help_requests_target_check,
  DROP CONSTRAINT help_requests_kind_check,
  DROP CONSTRAINT help_requests_closed_check,
  MODIFY COLUMN open_target VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY status = BINARY 'open' THEN
          CASE
            WHEN notice_id IS NOT NULL THEN CONCAT('n', notice_id)
            WHEN supply_id IS NOT NULL THEN CONCAT('s', supply_id)
            ELSE 'g'
          END
        ELSE NULL
      END
    ) STORED,
  ADD CONSTRAINT help_requests_id_class_unique UNIQUE (id, class_id),
  ADD CONSTRAINT help_requests_target_v2_check CHECK (
    (kind = 'general' AND notice_id IS NULL AND supply_id IS NULL)
    OR (kind <> 'general' AND notice_id IS NOT NULL AND supply_id IS NULL)
    OR (kind <> 'general' AND notice_id IS NULL AND supply_id IS NOT NULL)
  ),
  ADD CONSTRAINT help_requests_kind_v2_check CHECK (kind IN ('question', 'hard_to_prepare', 'general')),
  ADD CONSTRAINT help_requests_closed_v2_check CHECK (
    (status = 'open' AND closed_at IS NULL)
    OR (status = 'resolved' AND closed_at IS NOT NULL)
    OR (status = 'withdrawn' AND closed_at IS NOT NULL AND reply IS NULL)
  );

-- 주고받은 말은 고치거나 지우지 않는다(교권 보호·분쟁 대비 기록). 대화·작성자 구성원이 실제로
-- 지워질 때만 함께 지워져 기존 보존·파기 흐름을 막지 않는다. 작성자가 그 대화의 학생이나 담임인지는 API가 확인한다.
CREATE TABLE help_request_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  help_request_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  author_member_id BIGINT NOT NULL,
  body VARCHAR(500) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT help_request_messages_request_fk FOREIGN KEY (help_request_id, class_id)
    REFERENCES help_requests (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_request_messages_author_fk FOREIGN KEY (author_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_request_messages_body_check CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 500),
  INDEX help_request_messages_request_index (help_request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 새 메시지 알림도 기존 수업·밤 보류 대기열을 그대로 쓴다.
ALTER TABLE push_deliveries
  DROP CONSTRAINT push_deliveries_kind_check,
  ADD CONSTRAINT push_deliveries_kind_v2_check CHECK (kind IN ('reminder', 'schedule_changed', 'help_message'));
