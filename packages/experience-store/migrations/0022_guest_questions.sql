BEGIN;

-- 予約前の質問 (#105 traveler, #106 host; owner decision 2026-10-31): questions to the host live in
-- the experience DB, not in NIHO. One thread per question a guest sends from an experience page.
-- The guest's email address is kept here only so the mail worker can send the host's reply; it never
-- leaves the store through the host's reads, the outbox, logs or URLs. No IP addresses are kept.
-- guest_email_key (lower(guest_email)) only counts a guest's questions for the rate limit.
CREATE TABLE guest_question_threads (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  topic text NOT NULL CHECK (topic IN ('CHILDREN', 'FOOD', 'ACCESS', 'LANGUAGE', 'OTHER')),
  guest_name text NOT NULL CHECK (
    length(guest_name) BETWEEN 1 AND 100 AND guest_name = btrim(guest_name) AND guest_name !~ '[[:cntrl:]]'
  ),
  guest_email text NOT NULL CHECK (
    length(guest_email) BETWEEN 3 AND 254 AND guest_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  guest_email_key text NOT NULL CHECK (guest_email_key = lower(guest_email)),
  guest_language text NOT NULL CHECK (guest_language IN ('EN', 'JA')),
  client_request_key text NOT NULL CHECK (length(client_request_key) BETWEEN 8 AND 120),
  -- The guest wrote last and the host has not answered yet.
  needs_reply boolean NOT NULL DEFAULT true,
  -- Null until the OWNER opens the thread, and again after each guest reply.
  host_read_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, id),
  -- The same question sent again (a retry) is one thread.
  UNIQUE (provider_id, product_id, client_request_key),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

-- メッセージ's list: the provider's threads, the latest first (keyset on last_message_at, id).
CREATE INDEX guest_question_threads_host_list_idx
  ON guest_question_threads (provider_id, last_message_at DESC, id DESC);

-- Rate limits: new threads per product and guest address, and per product, in the last hour.
CREATE INDEX guest_question_threads_rate_email_idx
  ON guest_question_threads (provider_id, product_id, guest_email_key, created_at);
CREATE INDEX guest_question_threads_rate_product_idx
  ON guest_question_threads (provider_id, product_id, created_at);

-- What the guest wrote (body; body_ja is the Japanese translation, filled by a later slice) and what
-- the host sent (body is the English that reaches the guest; body_ja the Japanese the host wrote, or
-- null when they wrote the English directly). Only HOST messages are delivered by email: the mail
-- worker claims PENDING ones (or SENDING ones whose lease ran out). A PENDING message's lease_until
-- is the time after which a retry may be claimed again.
CREATE TABLE guest_question_messages (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  thread_id uuid NOT NULL,
  author text NOT NULL CHECK (author IN ('GUEST', 'HOST')),
  source text NOT NULL CHECK (source IN ('SITE_FORM', 'REPLY_PAGE', 'HOST_CONSOLE')),
  body text NOT NULL CHECK (btrim(body) <> ''),
  body_ja text CHECK (body_ja IS NULL OR (btrim(body_ja) <> '' AND length(body_ja) <= 4000)),
  author_niho_user_id text CHECK (author_niho_user_id IS NULL OR length(author_niho_user_id) BETWEEN 1 AND 256),
  -- 返信: the host console's idempotency key; the same command is the same message.
  command_id uuid,
  -- The reply page's idempotency key for a guest's answer.
  client_request_key text CHECK (client_request_key IS NULL OR length(client_request_key) BETWEEN 8 AND 120),
  delivery_status text CHECK (delivery_status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 5),
  lease_until timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, id),
  UNIQUE (provider_id, thread_id, id),
  UNIQUE (provider_id, command_id),
  UNIQUE (provider_id, thread_id, client_request_key),
  FOREIGN KEY (provider_id, thread_id) REFERENCES guest_question_threads(provider_id, id) ON DELETE CASCADE,
  -- ASK_HOST_INPUT_LIMITS.messageMaxLength (guest) and MESSAGE_TEXT_LIMIT (host).
  CHECK ((author = 'GUEST' AND length(body) <= 1000) OR (author = 'HOST' AND length(body) <= 4000)),
  CHECK ((author = 'GUEST' AND source IN ('SITE_FORM', 'REPLY_PAGE')) OR (author = 'HOST' AND source = 'HOST_CONSOLE')),
  CHECK ((author = 'HOST') = (author_niho_user_id IS NOT NULL)),
  CHECK ((author = 'HOST') = (command_id IS NOT NULL)),
  CHECK ((source = 'REPLY_PAGE') = (client_request_key IS NOT NULL)),
  CHECK ((author = 'HOST') = (delivery_status IS NOT NULL)),
  CHECK (author = 'HOST' OR (delivery_attempts = 0 AND lease_until IS NULL AND delivered_at IS NULL)),
  CHECK ((delivery_status = 'SENT') = (delivered_at IS NOT NULL)),
  CHECK (delivery_status IS DISTINCT FROM 'SENDING' OR lease_until IS NOT NULL),
  CHECK (delivery_status NOT IN ('SENT', 'FAILED') OR lease_until IS NULL)
);

CREATE INDEX guest_question_messages_thread_idx
  ON guest_question_messages (provider_id, thread_id, created_at, id);

-- The mail worker's queue.
CREATE INDEX guest_question_messages_delivery_idx
  ON guest_question_messages (created_at, id)
  WHERE delivery_status IN ('PENDING', 'SENDING');

-- One-time links to the reply page, one per delivery of a host reply. Only the SHA-256 of the
-- token is kept; the token itself exists only in the email (in the URL fragment). A link answers
-- once; the same answer sent again (the same client_request_key) is not a second one.
CREATE TABLE guest_question_reply_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  provider_id text NOT NULL,
  thread_id uuid NOT NULL,
  host_message_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_client_request_key text CHECK (used_client_request_key IS NULL OR length(used_client_request_key) BETWEEN 8 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, thread_id) REFERENCES guest_question_threads(provider_id, id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, thread_id, host_message_id)
    REFERENCES guest_question_messages(provider_id, thread_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK ((used_at IS NULL) = (used_client_request_key IS NULL))
);

CREATE INDEX guest_question_reply_tokens_message_idx
  ON guest_question_reply_tokens (provider_id, host_message_id);

-- The public question form finds the experience by its slug alone (unique per provider).
CREATE INDEX experience_products_published_slug_idx
  ON experience_products (slug)
  WHERE status = 'PUBLISHED';

COMMIT;
