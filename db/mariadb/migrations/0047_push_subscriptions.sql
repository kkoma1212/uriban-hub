-- 통합순7 웹 푸시: 브라우저별 푸시 구독. 학급은 저장하지 않고 발송 때마다 소속을 다시 확인한다.
CREATE TABLE push_subscriptions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  endpoint VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  p256dh VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth_secret VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT push_subscriptions_endpoint_check CHECK (endpoint LIKE 'https://%'),
  CONSTRAINT push_subscriptions_updated_check CHECK (updated_at >= created_at),
  INDEX push_subscriptions_user_index (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
