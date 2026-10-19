-- T-CLASS-CHAT(2026-09-28 사용자 결정): 반 단체 대화 — 선생님 관리형. 설계 DB 기록 planning/class-chat-20260928.
-- 원장 번호 94·95(Codex 90~93, 프로필 사진 88·89 다음으로 예약). 기존 표는 바꾸지 않는다(새 표 네 개만).
-- 반의 승인된 구성원만 보고 쓴다(API가 확인). 방은 담임이 열고 닫는다(기본 닫힘).

-- 반마다 방 하나. 줄이 없으면 닫힌 방으로 본다.
-- *_by_member_id 열(바꾼·가린·제한한·처리한 담임)은 기록용 번호라 외래 키를 두지 않는다 — 담임 구성원이
-- 지워져도 방·메시지·신고 기록은 남아야 하고, 복합 키의 한 열만 NULL로 만드는 동작은 두 DB에서 다르다.
CREATE TABLE class_chat_rooms (
  class_id BIGINT NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_by_member_id BIGINT NULL,
  PRIMARY KEY (class_id),
  CONSTRAINT class_chat_rooms_class_fk FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 말은 고치거나 지우지 않는다(분쟁 대비 기록). 담임은 가리기만 한다(hidden_*). 구성원이 실제로 지워질 때만 함께 지워진다.
CREATE TABLE class_chat_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  author_member_id BIGINT NOT NULL,
  body VARCHAR(500) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  hidden_at DATETIME(6) NULL,
  hidden_by_member_id BIGINT NULL,
  PRIMARY KEY (id),
  CONSTRAINT class_chat_messages_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_chat_messages_author_fk FOREIGN KEY (author_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_messages_body_check CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 500),
  CONSTRAINT class_chat_messages_hidden_check CHECK (
    (hidden_at IS NULL AND hidden_by_member_id IS NULL) OR hidden_at IS NOT NULL
  ),
  INDEX class_chat_messages_class_index (class_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 담임이 학생의 말하기를 잠시 막는다. 기간이 지나면 저절로 풀린다(줄은 남아도 무시).
CREATE TABLE class_chat_mutes (
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  muted_until DATETIME(6) NOT NULL,
  created_by_member_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (class_id, member_id),
  CONSTRAINT class_chat_mutes_member_fk FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 신고는 담임에게 보인다. 한 사람이 같은 메시지를 두 번 신고하지 않는다.
CREATE TABLE class_chat_reports (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  reporter_member_id BIGINT NOT NULL,
  reason VARCHAR(200) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  resolved_at DATETIME(6) NULL,
  resolved_by_member_id BIGINT NULL,
  PRIMARY KEY (id),
  CONSTRAINT class_chat_reports_message_reporter_unique UNIQUE (message_id, reporter_member_id),
  CONSTRAINT class_chat_reports_message_fk FOREIGN KEY (message_id, class_id)
    REFERENCES class_chat_messages (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_reports_reporter_fk FOREIGN KEY (reporter_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE CASCADE,
  CONSTRAINT class_chat_reports_reason_check CHECK (CHAR_LENGTH(reason) BETWEEN 1 AND 200),
  INDEX class_chat_reports_open_index (class_id, resolved_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
