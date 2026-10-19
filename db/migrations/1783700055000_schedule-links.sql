-- Up Migration
-- 통합순8 영구 연결: 일정에 관련 공지·준비물을 선택적으로 연결한다(간단한 공지에 강제하지 않음).
-- (id, class_id) 복합 외래키로 같은 반의 항목끼리만 연결되게 DB가 막는다. 원 항목이 실제로
-- 지워지면 연결도 함께 지운다(보존·파기 흐름을 막지 않음). 작성자는 감사 기록으로 추적한다.
CREATE TABLE schedule_notice_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  schedule_id BIGINT NOT NULL,
  notice_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT schedule_notice_links_pair_unique UNIQUE (schedule_id, notice_id),
  CONSTRAINT schedule_notice_links_schedule_fk FOREIGN KEY (schedule_id, class_id)
    REFERENCES schedules (id, class_id) ON DELETE CASCADE,
  CONSTRAINT schedule_notice_links_notice_fk FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE
);
CREATE INDEX schedule_notice_links_notice_index ON schedule_notice_links(notice_id, class_id);

CREATE TABLE schedule_supply_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  schedule_id BIGINT NOT NULL,
  supply_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT schedule_supply_links_pair_unique UNIQUE (schedule_id, supply_id),
  CONSTRAINT schedule_supply_links_schedule_fk FOREIGN KEY (schedule_id, class_id)
    REFERENCES schedules (id, class_id) ON DELETE CASCADE,
  CONSTRAINT schedule_supply_links_supply_fk FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE
);
CREATE INDEX schedule_supply_links_supply_index ON schedule_supply_links(supply_id, class_id);

REVOKE ALL ON schedule_notice_links FROM PUBLIC;
REVOKE ALL ON schedule_supply_links FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON schedule_notice_links TO classhub_app;
GRANT SELECT, INSERT, DELETE ON schedule_supply_links TO classhub_app;
INSERT INTO audit_log_actions (action) VALUES ('schedule.links_updated');

-- Down Migration
-- 감사 기록이 이 작업명을 참조하면 지우지 못하는 것이 맞다(기록 보존).
DELETE FROM audit_log_actions WHERE action = 'schedule.links_updated';
-- 연결은 원 항목에서 다시 만들 수 있는 보조 정보라 보존 대상 기록이 아니다.
REVOKE ALL ON schedule_supply_links FROM classhub_app;
REVOKE ALL ON schedule_notice_links FROM classhub_app;
DROP TABLE schedule_supply_links;
DROP TABLE schedule_notice_links;
