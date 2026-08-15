-- migrations/004_rollback.sql
BEGIN;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS tower_operators;
COMMIT;
