-- Up Migration
-- 통합순7 웹 푸시: 브라우저별 푸시 구독. 학급은 저장하지 않는다 — 발송 때마다
-- 계정 상태와 현재 학급 소속을 다시 확인한다. 같은 브라우저 주소를 다른 계정이
-- 구독하면 주인이 바뀐다(공용 기기에서 이전 학생에게 알림이 가지 않게).
CREATE TABLE push_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(1024) NOT NULL,
  p256dh VARCHAR(128) NOT NULL,
  auth_secret VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_endpoint_check CHECK (endpoint LIKE 'https://%'),
  CONSTRAINT push_subscriptions_updated_check CHECK (updated_at >= created_at)
);
CREATE INDEX push_subscriptions_user_index ON push_subscriptions(user_id);
REVOKE ALL ON push_subscriptions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO classhub_app;
GRANT UPDATE (user_id, p256dh, auth_secret, updated_at) ON push_subscriptions TO classhub_app;

-- Down Migration
-- 구독은 브라우저에서 다시 받을 수 있는 연결 정보라 보존 대상 기록이 아니다.
REVOKE ALL ON push_subscriptions FROM classhub_app;
DROP TABLE push_subscriptions;
