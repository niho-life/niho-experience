BEGIN;

-- 運営の CLI (#576 ⑤): the office also writes articles through the /write API (the same routes the writers use), so the audit
-- table takes those paths as well as /admin/api. Only the CHECK on request_path changes; no row is touched.
ALTER TABLE operator_cli_requests DROP CONSTRAINT operator_cli_requests_request_path_check;
ALTER TABLE operator_cli_requests ADD CONSTRAINT operator_cli_requests_request_path_check
  CHECK ((request_path LIKE '/admin/api/%' OR request_path LIKE '/write/api/%') AND length(request_path) <= 512);

COMMIT;
