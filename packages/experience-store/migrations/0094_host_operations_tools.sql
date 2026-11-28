BEGIN;

-- #711 (Epic #700 stage 4): the office's tools for a host.
--
--   * A provider (host) can be suspended by operations as a whole: its three suspension columns are all NULL or all set.
--     The experiences it had public are suspended one by one with the code PROVIDER_SUSPENDED (the store does that in the
--     same transaction); the provider row says that new publishing and bookings are closed for it.
--   * experience_provider_operations_events is the append-only log of those suspensions and lifts.
--   * experience_office_notices queues the notices to the office's mailbox (the first page of a host published, the first
--     bookings of a host opened). One row per (provider, kind): the key is what keeps a notice from being sent twice.

ALTER TABLE experience_providers
  ADD COLUMN operations_suspended_at timestamptz,
  ADD COLUMN operations_suspension_code text CHECK (operations_suspension_code IS NULL OR operations_suspension_code ~ '^[A-Z0-9_]{1,80}$'),
  ADD COLUMN operations_suspended_by_niho_user_id text CHECK (operations_suspended_by_niho_user_id IS NULL OR length(operations_suspended_by_niho_user_id) BETWEEN 1 AND 256),
  ADD CONSTRAINT experience_providers_operations_suspension_all_or_none CHECK (
    (operations_suspended_at IS NULL AND operations_suspension_code IS NULL AND operations_suspended_by_niho_user_id IS NULL)
    OR (operations_suspended_at IS NOT NULL AND operations_suspension_code IS NOT NULL AND operations_suspended_by_niho_user_id IS NOT NULL)
  );

CREATE TABLE experience_provider_operations_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('SUSPENDED', 'CLEARED')),
  reason text NOT NULL CHECK (reason ~ '^[A-Z0-9_]{1,80}$'),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX experience_provider_operations_events_provider_idx
  ON experience_provider_operations_events (provider_id, id DESC);

CREATE TRIGGER experience_provider_operations_events_no_update
BEFORE UPDATE OR DELETE ON experience_provider_operations_events
FOR EACH ROW EXECUTE FUNCTION reject_experience_booking_event_mutation();

-- The office's suspension and reactivation of a host account (from the Admin screen or the operator CLI), append-only.
CREATE TABLE host_account_operation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('SUSPENDED', 'REACTIVATED')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX host_account_operation_events_account_idx ON host_account_operation_events (host_account_id, id DESC);

CREATE TRIGGER host_account_operation_events_no_update
BEFORE UPDATE OR DELETE ON host_account_operation_events
FOR EACH ROW EXECUTE FUNCTION reject_experience_booking_event_mutation();

-- Notices to the office's mailbox. claim_token changes with every claim: a report from an earlier claim (a worker whose lease
-- ran out) matches nothing.
CREATE TABLE experience_office_notices (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('FIRST_PAGE_PUBLISHED', 'FIRST_BOOKING_OPENED')),
  -- Public names and titles only: never a guest's or an owner's personal data.
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, kind)
);

CREATE INDEX experience_office_notices_due_idx ON experience_office_notices (created_at) WHERE status IN ('PENDING', 'SENDING');

COMMIT;
