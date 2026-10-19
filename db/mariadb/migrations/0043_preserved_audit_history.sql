-- Preserve existing audit history for inactive seat/team/duty features.
-- Keep every original JSON allowlist; no feature tables or grants are added.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_json_allowlist_check,
  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'class.%' AND action <> 'class.teacher_transferred' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'invite_code.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'member.%' OR action = 'class.teacher_transferred' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(after_json)) = 1))
      WHEN action IN ('notice.reminder_created', 'supply.reminder_created') THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '[]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '[]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["reminder_batch_id","content_revision","current_unresolved_count","created_count","cooldown_suppressed_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'notice.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'supply.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'attendance_notification.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'poll.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'seat_draw.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'team_draw.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'duty_role.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'duty_roster.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      ELSE
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(after_json)) = 1))
    END
  );
