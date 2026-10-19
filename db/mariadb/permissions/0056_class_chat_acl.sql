-- Activate together with the class chat module; leave the installation baseline intact.
GRANT SELECT, INSERT, UPDATE (is_open, updated_at, updated_by_member_id) ON classhub_mariadb_phase1_dev.class_chat_rooms TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE (hidden_at, hidden_by_member_id) ON classhub_mariadb_phase1_dev.class_chat_messages TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE (muted_until, created_by_member_id, created_at), DELETE ON classhub_mariadb_phase1_dev.class_chat_mutes TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE (resolved_at, resolved_by_member_id) ON classhub_mariadb_phase1_dev.class_chat_reports TO 'classhub_app'@'%';
