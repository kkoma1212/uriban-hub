-- 통합순8 영구 연결: 일정에 관련 공지·준비물을 선택적으로 연결한다(간단한 공지에 강제하지 않음).
-- (id, class_id) 복합 외래키로 같은 반의 항목끼리만 연결되게 DB가 막는다. 원 항목이 실제로
-- 지워지면 연결도 함께 지운다(보존·파기 흐름을 막지 않음). 작성자는 감사 기록으로 추적한다.
CREATE TABLE schedule_notice_links (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  schedule_id BIGINT NOT NULL,
  notice_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT schedule_notice_links_pair_unique UNIQUE (schedule_id, notice_id),
  CONSTRAINT schedule_notice_links_schedule_fk FOREIGN KEY (schedule_id, class_id)
    REFERENCES schedules (id, class_id) ON DELETE CASCADE,
  CONSTRAINT schedule_notice_links_notice_fk FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  INDEX schedule_notice_links_schedule_index (schedule_id, class_id),
  INDEX schedule_notice_links_notice_index (notice_id, class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE schedule_supply_links (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  schedule_id BIGINT NOT NULL,
  supply_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT schedule_supply_links_pair_unique UNIQUE (schedule_id, supply_id),
  CONSTRAINT schedule_supply_links_schedule_fk FOREIGN KEY (schedule_id, class_id)
    REFERENCES schedules (id, class_id) ON DELETE CASCADE,
  CONSTRAINT schedule_supply_links_supply_fk FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  INDEX schedule_supply_links_schedule_index (schedule_id, class_id),
  INDEX schedule_supply_links_supply_index (supply_id, class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO audit_log_actions (action) VALUES ('schedule.links_updated');
