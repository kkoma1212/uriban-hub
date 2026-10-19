-- Up Migration

-- Prepared only. Apply to an isolated database until explicit operating approval.
-- 생년월일(2026-10-01 사용자 결정): 만 14세 자동 판단 · 담임의 학생 확인 · 동의한 학생의 생일 알림.
-- 이미 가입한 계정은 비어 있다(NULL). 익명 처리되는 순간 트리거가 생년월일과 생일 공개 동의를 지운다.
ALTER TABLE users
  ADD COLUMN birth_date DATE,
  ADD COLUMN birthday_shared BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT users_birth_date_check CHECK (birth_date >= DATE '1900-01-01'),
  ADD CONSTRAINT users_birthday_shared_check CHECK (NOT birthday_shared OR birth_date IS NOT NULL);

CREATE FUNCTION clear_birth_date_on_anonymize() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL THEN
    NEW.birth_date := NULL;
    NEW.birthday_shared := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_birth_date_anonymize_guard
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION clear_birth_date_on_anonymize();

-- Down Migration

DO $birth_date_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE birth_date IS NOT NULL) THEN
    RAISE EXCEPTION 'Recorded birth dates must be preserved; roll back the application only';
  END IF;
END;
$birth_date_rollback_guard$;
DROP TRIGGER users_birth_date_anonymize_guard ON users;
DROP FUNCTION clear_birth_date_on_anonymize();
ALTER TABLE users DROP CONSTRAINT users_birthday_shared_check;
ALTER TABLE users DROP CONSTRAINT users_birth_date_check;
ALTER TABLE users DROP COLUMN birthday_shared;
ALTER TABLE users DROP COLUMN birth_date;
