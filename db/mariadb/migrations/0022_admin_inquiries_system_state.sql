-- T-HUB-64 phase 0022; isolated synthetic development only, runtime ACLs separate.
-- PostgreSQL source: 1783700043000_admin-inquiries-system-state.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

-- The source response all-or-none CHECK rejects deleting its respondent.
-- RESTRICT expresses this effective boundary without MariaDB SET NULL/CHECK error 1901.
CREATE TABLE admin_inquiries (
  id UUID NOT NULL PRIMARY KEY DEFAULT (CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))),
  requester_user_id BIGINT,
  CONSTRAINT admin_inquiries_requester_user_id_fk FOREIGN KEY (requester_user_id) REFERENCES users (id) ON DELETE SET NULL,
  subject LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (CHAR_LENGTH(subject) BETWEEN 1 AND 200),
  body LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 10000),
  status VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_admin_account_id BIGINT,
  CONSTRAINT admin_inquiries_assigned_admin_account_id_fk FOREIGN KEY (assigned_admin_account_id) REFERENCES admin_accounts (id) ON DELETE SET NULL,
  internal_note LONGTEXT COLLATE utf8mb4_nopad_bin CHECK (internal_note IS NULL OR CHAR_LENGTH(internal_note) <= 5000),
  response LONGTEXT COLLATE utf8mb4_nopad_bin CHECK (response IS NULL OR CHAR_LENGTH(response) BETWEEN 1 AND 10000),
  responded_by_admin_account_id BIGINT,
  CONSTRAINT admin_inquiries_responded_by_admin_account_id_fk FOREIGN KEY (responded_by_admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  responded_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  resolved_at DATETIME(6),
  CONSTRAINT admin_inquiries_response_state_check CHECK (
    (response IS NULL AND responded_by_admin_account_id IS NULL AND responded_at IS NULL)
    OR (response IS NOT NULL AND responded_by_admin_account_id IS NOT NULL AND responded_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX admin_inquiries_queue_index ON admin_inquiries(status, updated_at DESC);
CREATE TABLE admin_system_state (
  `key` VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL PRIMARY KEY CHECK (`key` IN ('maintenance_mode','announcement')),
  value_json JSON NOT NULL,
  updated_by_admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_system_state_updated_by_admin_account_id_fk FOREIGN KEY (updated_by_admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
