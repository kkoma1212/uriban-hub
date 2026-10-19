-- Up Migration
-- T-CLASS-CHAT(2026-09-28 사용자 결정): 반 단체 대화 — 선생님 관리형. 설계 DB 기록 planning/class-chat-20260928.
-- 운영 DB 적용은 사용자 승인 뒤. 기존 표는 바꾸지 않는다(새 표 네 개만).
-- *_by_member_id 열은 기록용 번호라 외래 키를 두지 않는다(담임 구성원이 지워져도 기록은 남는다).
CREATE TABLE class_chat_rooms (
  class_id BIGINT PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE,
  is_open BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by_member_id BIGINT
);

-- 말은 고치거나 지우지 않는다(분쟁 대비 기록). 담임은 가리기만 한다.
CREATE TABLE class_chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  author_member_id BIGINT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  hidden_at TIMESTAMPTZ,
  hidden_by_member_id BIGINT,
  CONSTRAINT class_chat_messages_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_chat_messages_author_fk FOREIGN KEY (author_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_messages_body_check CHECK (char_length(body) BETWEEN 1 AND 500),
  CONSTRAINT class_chat_messages_hidden_check CHECK (
    (hidden_at IS NULL AND hidden_by_member_id IS NULL) OR hidden_at IS NOT NULL
  )
);
CREATE INDEX class_chat_messages_class_index ON class_chat_messages(class_id, id);

CREATE TABLE class_chat_mutes (
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  muted_until TIMESTAMPTZ NOT NULL,
  created_by_member_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (class_id, member_id),
  CONSTRAINT class_chat_mutes_member_fk FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE
);

CREATE TABLE class_chat_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  reporter_member_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  resolved_by_member_id BIGINT,
  CONSTRAINT class_chat_reports_message_reporter_unique UNIQUE (message_id, reporter_member_id),
  CONSTRAINT class_chat_reports_message_fk FOREIGN KEY (message_id, class_id)
    REFERENCES class_chat_messages (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_reports_reporter_fk FOREIGN KEY (reporter_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_reports_reason_check CHECK (char_length(reason) BETWEEN 1 AND 200)
);
CREATE INDEX class_chat_reports_open_index ON class_chat_reports(class_id, resolved_at, id);

REVOKE ALL ON class_chat_rooms, class_chat_messages, class_chat_mutes, class_chat_reports FROM PUBLIC;
GRANT SELECT, INSERT ON class_chat_rooms TO classhub_app;
GRANT UPDATE (is_open, updated_at, updated_by_member_id) ON class_chat_rooms TO classhub_app;
GRANT SELECT, INSERT ON class_chat_messages TO classhub_app;
GRANT UPDATE (hidden_at, hidden_by_member_id) ON class_chat_messages TO classhub_app;
GRANT SELECT, INSERT, DELETE ON class_chat_mutes TO classhub_app;
GRANT UPDATE (muted_until, created_by_member_id, created_at) ON class_chat_mutes TO classhub_app;
GRANT SELECT, INSERT ON class_chat_reports TO classhub_app;
GRANT UPDATE (resolved_at, resolved_by_member_id) ON class_chat_reports TO classhub_app;

-- Down Migration
-- 대화 내용에는 학생 개인 사정이 담길 수 있어 되돌릴 때 함께 지운다. 운영에서는 먼저 기능 스위치를 끄고 보관이 필요하면 내보낸 뒤 실행한다.
REVOKE ALL ON class_chat_reports, class_chat_mutes, class_chat_messages, class_chat_rooms FROM classhub_app;
DROP TABLE class_chat_reports;
DROP TABLE class_chat_mutes;
DROP TABLE class_chat_messages;
DROP TABLE class_chat_rooms;
