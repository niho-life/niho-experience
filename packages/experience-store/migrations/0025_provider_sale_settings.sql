BEGIN;

-- 旅行者の予約 (#285 slice 2): what NIHO charges a provider for each booking travelers make on this
-- site. Additive only (a new table): the current writer neither reads nor writes it, so this migration
-- may run before the new revision.

-- One row per provider whose products are sold to travelers here. No row means none of its products is
-- offered (fail closed): the fee is never assumed. The owner decided (2026-10-31, #285) 10 % with NIHO
-- support off and 15 % with it on, payment fees included; each booking keeps the fee of the moment it
-- was taken in its pricing snapshot, so a change here applies to later bookings only. Only NIHO's
-- server-side import or Admin writes this table, never a host.
CREATE TABLE provider_sale_settings (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  support_enabled boolean NOT NULL,
  platform_fee_basis_points integer NOT NULL CHECK (platform_fee_basis_points IN (1000, 1500)),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (support_enabled AND platform_fee_basis_points = 1500)
    OR (NOT support_enabled AND platform_fee_basis_points = 1000)
  )
);

COMMIT;
