-- Immutable keys preserve transaction-scoped operator locks on MariaDB.
-- Only the operator account receives SELECT; runtime code cannot change seeds.
CREATE TABLE operator_transaction_lock_keys (
  lock_digest BINARY(32) NOT NULL,
  PRIMARY KEY (lock_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO operator_transaction_lock_keys (lock_digest) VALUES
  (0x49ecc4d52325bce29ca46763a5cc2cd557573910b4506e8a731712a86d3c84ee),
  (0xee4b38b03e249f74328253417af2db23cd2d749dbff182155251e3bc203f0b92),
  (0x2406290d75e9464fbfb5c8c87f7478d7e411b77924877ade288d862d01eda490),
  (0x26b0555647a733158068d62d58df5ac4a556a031897543010ff80181f61322ee),
  (0xad0d9815d6ab35d16c973eb8cb784b28c56f44aec2b252aba536c433a346c1ac),
  (0xbca667ba2fd37dad785be99bb2c921667aa75f77f2acc9b2436b0d168949cadd),
  (0x9d6b69d518521498be404081b2a829fd8a67e3ae54e6bfb11563f1ccfed6373d);

GRANT SELECT ON classhub_mariadb_phase1_dev.operator_transaction_lock_keys TO 'classhub_operator'@'%';
-- Existing holiday sync removes stale dates only in the requested year.
GRANT DELETE ON classhub_mariadb_phase1_dev.public_holidays TO 'classhub_operator'@'%';
