BEGIN;

-- Article/product link invitations are consent records, not provider memberships. They contain
-- only stable NIHO user IDs; email, names, and private profile data remain in NIHO.
CREATE TABLE guide_product_link_invitations (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  writer_niho_user_id text NOT NULL CHECK (length(writer_niho_user_id) BETWEEN 1 AND 256),
  invited_by_niho_user_id text NOT NULL CHECK (length(invited_by_niho_user_id) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  declined_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, writer_niho_user_id),
  CHECK (
    (state = 'PENDING' AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL)
    OR (state = 'ACCEPTED' AND accepted_at IS NOT NULL AND declined_at IS NULL AND revoked_at IS NULL)
    OR (state = 'DECLINED' AND accepted_at IS NULL AND declined_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND declined_at IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX guide_product_link_invitations_writer_pending_idx
  ON guide_product_link_invitations (writer_niho_user_id, invited_at, id)
  WHERE state = 'PENDING';

CREATE INDEX guide_product_link_invitations_provider_idx
  ON guide_product_link_invitations (provider_id, updated_at DESC, id);

-- No previous invitation workflow existed. Retire legacy projection rows so an explicit
-- invitation and acceptance are required before a writer can link a provider's products.
UPDATE guide_product_link_memberships
   SET active=false, updated_at=clock_timestamp()
 WHERE active=true;

COMMIT;
