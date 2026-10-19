-- 통합순9 도움 요청(채팅 아님): 학생이 공지·준비물에 '질문 있어요/준비하기 어려워요'를 남기고
-- 담임이 처리 완료와 선택 한 줄 답변을 남긴다. 요청 해결은 안내 확인·준비물 자기체크와 별도 상태다.
-- 같은 학생·같은 안내에는 처리 중(open) 요청을 하나만 둔다(해결·철회 뒤 새 요청 가능).
-- 원 안내나 학급 구성원이 실제로 지워지면 요청도 함께 지운다(보존·파기 흐름을 막지 않음).
CREATE TABLE help_requests (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  notice_id BIGINT,
  supply_id BIGINT,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message VARCHAR(200),
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  reply VARCHAR(200),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  closed_at DATETIME(6),
  open_target VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY status = BINARY 'open' THEN
          CASE WHEN notice_id IS NOT NULL THEN CONCAT('n', notice_id) ELSE CONCAT('s', supply_id) END
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT help_requests_open_unique UNIQUE (member_id, open_target),
  CONSTRAINT help_requests_member_fk FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_notice_fk FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_supply_fk FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_target_check CHECK (
    (notice_id IS NOT NULL AND supply_id IS NULL) OR (notice_id IS NULL AND supply_id IS NOT NULL)
  ),
  CONSTRAINT help_requests_kind_check CHECK (kind IN ('question', 'hard_to_prepare')),
  CONSTRAINT help_requests_status_check CHECK (status IN ('open', 'resolved', 'withdrawn')),
  CONSTRAINT help_requests_closed_check CHECK (
    (status = 'open' AND closed_at IS NULL AND reply IS NULL)
    OR (status = 'resolved' AND closed_at IS NOT NULL)
    OR (status = 'withdrawn' AND closed_at IS NOT NULL AND reply IS NULL)
  ),
  CONSTRAINT help_requests_message_check CHECK (message IS NULL OR CHAR_LENGTH(message) BETWEEN 1 AND 200),
  CONSTRAINT help_requests_reply_check CHECK (reply IS NULL OR CHAR_LENGTH(reply) BETWEEN 1 AND 200),
  INDEX help_requests_class_status_index (class_id, status, created_at),
  INDEX help_requests_notice_index (notice_id, class_id),
  INDEX help_requests_supply_index (supply_id, class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
