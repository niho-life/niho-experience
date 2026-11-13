BEGIN;

-- 運営の CLI (#576, docs/operator-cli.md): a signed-in admin's own Google ID token, sent from a command line to the same
-- /admin APIs the Admin screens use. Every request that changes something is recorded here before it runs: who (the
-- admin's `adm_` actor ID, never the address), through which AI ("claude-code", "codex", "other" or "human": what the
-- caller says about itself, not proof), which operation (the caller's operation ID, so a repeat of the same operation is
-- refused instead of run twice), the method, the path and the SHA-256 of the body. The body itself is not kept.
--
-- Additive only (a new table and an index): the current writer neither reads nor writes it. The runtime role needs INSERT
-- and SELECT. Rows are an audit trail: nothing updates or deletes them.
CREATE TABLE operator_cli_requests (
  request_ref uuid PRIMARY KEY,
  admin_actor_id text NOT NULL CHECK (admin_actor_id ~ '^adm_[0-9a-f]{32}$'),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9._:-]{8,64}$'),
  ai_kind text NOT NULL CHECK (ai_kind IN ('claude-code', 'codex', 'other', 'human')),
  http_method text NOT NULL CHECK (http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  request_path text NOT NULL CHECK (request_path LIKE '/admin/api/%' AND length(request_path) <= 512),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  recorded_at timestamptz NOT NULL,
  UNIQUE (admin_actor_id, operation_id)
);

-- An admin's recent operations, newest first.
CREATE INDEX operator_cli_requests_actor_idx ON operator_cli_requests (admin_actor_id, recorded_at DESC);

COMMIT;
