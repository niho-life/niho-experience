BEGIN;

ALTER TABLE google_channel_output_bindings
  ADD COLUMN initialize_missing_open_anchor boolean NOT NULL DEFAULT false;

-- Immutable OWNER activation evidence. This is a command acknowledgement,
-- not a Google receipt, an Airbnb observation, or reservation health.
CREATE TABLE google_channel_activation_commands (
  provider_id text NOT NULL,
  command_id uuid NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  account_version bigint NOT NULL CHECK (account_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  binding_version_before bigint NOT NULL CHECK (binding_version_before > 0),
  binding_version_after bigint NOT NULL CHECK (binding_version_after = binding_version_before + 1),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  binding_calendar_digest text NOT NULL CHECK (binding_calendar_digest ~ '^[0-9a-f]{64}$'),
  granted_scopes_digest text NOT NULL CHECK (granted_scopes_digest ~ '^[0-9a-f]{64}$'),
  setup_command_id uuid NOT NULL,
  anchor_command_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id,command_id),
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,actor_niho_user_id) REFERENCES provider_memberships(provider_id,niho_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,setup_command_id) REFERENCES google_channel_setup_journals(provider_id,command_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,anchor_command_id) REFERENCES google_channel_anchor_journals(provider_id,command_id) ON DELETE RESTRICT
);

CREATE INDEX google_channel_activation_listing_idx
  ON google_channel_activation_commands (provider_id,listing_id,occurrence_id,applied_at DESC);

COMMIT;
