-- 생년월일(2026-10-01 사용자 결정): 만 14세 자동 판단 · 담임의 학생 확인 · 동의한 학생의 생일 알림.
-- 교사·학생 모두 가입 때 받는다. 이미 가입한 계정은 비어 있다(NULL) — 설정에서 나중에 입력한다.
-- 탈퇴로 익명 처리되는 순간 아래 트리거가 생년월일과 생일 공개 동의를 지운다(탈퇴 루틴은 그대로 둔다).
-- 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인(원장 99).
ALTER TABLE users
  ADD COLUMN birth_date DATE NULL,
  ADD COLUMN birthday_shared BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT users_birth_date_check CHECK (birth_date >= '1900-01-01'),
  ADD CONSTRAINT users_birthday_shared_check CHECK (birthday_shared = FALSE OR birth_date IS NOT NULL);

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER users_birth_date_anonymize_guard
BEFORE UPDATE ON users
FOR EACH ROW
BEGIN
  IF NEW.anonymized_at IS NOT NULL THEN
    SET NEW.birth_date = NULL;
    SET NEW.birthday_shared = FALSE;
  END IF;
END//

DELIMITER ;
