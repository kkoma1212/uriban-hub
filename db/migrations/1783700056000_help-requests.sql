-- Up Migration
-- 통합순9 도움 요청(채팅 아님): 학생이 공지·준비물에 '질문 있어요/준비하기 어려워요'를 남기고
-- 담임이 처리 완료와 선택 한 줄 답변을 남긴다. 요청 해결은 안내 확인·준비물 자기체크와 별도 상태다.
-- 같은 학생·같은 안내에는 처리 중(open) 요청을 하나만 둔다(해결·철회 뒤 새 요청 가능).
-- 원 안내나 학급 구성원이 실제로 지워지면 요청도 함께 지운다(보존·파기 흐름을 막지 않음).
CREATE TABLE help_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  notice_id BIGINT,
  supply_id BIGINT,
  kind TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  open_target TEXT GENERATED ALWAYS AS (
    CASE
      WHEN status = 'open' THEN
        CASE WHEN notice_id IS NOT NULL THEN 'n' || notice_id ELSE 's' || supply_id END
      ELSE NULL
    END
  ) STORED,
  CONSTRAINT help_requests_open_unique UNIQUE (member_id, open_target),
  CONSTRAINT help_requests_member_fk FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_notice_fk FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_supply_fk FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  CONSTRAINT help_requests_target_check CHECK (num_nonnulls(notice_id, supply_id) = 1),
  CONSTRAINT help_requests_kind_check CHECK (kind IN ('question', 'hard_to_prepare')),
  CONSTRAINT help_requests_status_check CHECK (status IN ('open', 'resolved', 'withdrawn')),
  CONSTRAINT help_requests_closed_check CHECK (
    (status = 'open' AND closed_at IS NULL AND reply IS NULL)
    OR (status = 'resolved' AND closed_at IS NOT NULL)
    OR (status = 'withdrawn' AND closed_at IS NOT NULL AND reply IS NULL)
  ),
  CONSTRAINT help_requests_message_check CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 200),
  CONSTRAINT help_requests_reply_check CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 200)
);
CREATE INDEX help_requests_class_status_index ON help_requests(class_id, status, created_at);
CREATE INDEX help_requests_notice_index ON help_requests(notice_id, class_id);
CREATE INDEX help_requests_supply_index ON help_requests(supply_id, class_id);

REVOKE ALL ON help_requests FROM PUBLIC;
GRANT SELECT, INSERT ON help_requests TO classhub_app;
GRANT UPDATE (status, reply, closed_at) ON help_requests TO classhub_app;

-- Down Migration
-- 요청 내용은 학생 개인 사정이 담길 수 있어 되돌릴 때 함께 지운다(보관 기준은 별도 결정).
REVOKE ALL ON help_requests FROM classhub_app;
DROP TABLE help_requests;
