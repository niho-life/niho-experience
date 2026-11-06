BEGIN;

-- ホスト紹介文 (bio, #146): one public bio per Experience provider, written by its current OWNER
-- and shown on every currently public experience page of that provider (docs/host-bio.md).
-- Japanese is the source. English is published only while english_source_fingerprint equals the
-- sha256 (hex) of the current bio_ja, which the Store computes when the OWNER confirms the English.
-- Withdrawal deletes the row; no history or command receipt is kept. The bio never receives NIHO
-- profile, KYC or Stripe data. Limits match HOST_BIO_LIMITS in src/host-bio-rules.ts.
CREATE TABLE provider_host_bios (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  bio_ja text NOT NULL CHECK (
    char_length(bio_ja) BETWEEN 1 AND 600
    AND bio_ja !~ '^\s|\s$'
    -- Paragraph line breaks (LF) are allowed; CR and other control characters are not.
    AND replace(bio_ja, chr(10), '') !~ '[[:cntrl:]]'
  ),
  bio_en text CHECK (
    char_length(bio_en) BETWEEN 1 AND 1500
    AND bio_en !~ '^\s|\s$'
    AND replace(bio_en, chr(10), '') !~ '[[:cntrl:]]'
  ),
  english_source_fingerprint text CHECK (english_source_fingerprint ~ '^[0-9a-f]{64}$'),
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 160),
  consented_at timestamptz NOT NULL,
  consented_by_niho_user_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((bio_en IS NULL) = (english_source_fingerprint IS NULL)),
  FOREIGN KEY (provider_id, consented_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT
);

COMMIT;
