BEGIN;

-- Experience owns support settings for new Experience bookings. Existing sale-setting rows remain
-- unconsented (NULL) until the current OWNER explicitly accepts this policy in the host console.
ALTER TABLE provider_sale_settings
  ADD COLUMN support_consent_version text CHECK (support_consent_version IS NULL OR length(support_consent_version) BETWEEN 1 AND 64),
  ADD COLUMN support_agreement_revision bigint CHECK (support_agreement_revision IS NULL OR support_agreement_revision > 0),
  ADD COLUMN support_consented_by text CHECK (support_consented_by IS NULL OR length(support_consented_by) BETWEEN 1 AND 256),
  ADD COLUMN support_consented_at timestamptz,
  ADD CONSTRAINT provider_sale_settings_support_consent_pair_check CHECK (
    (support_consent_version IS NULL) = (support_agreement_revision IS NULL)
    AND (support_consent_version IS NULL) = (support_consented_by IS NULL)
    AND (support_consent_version IS NULL) = (support_consented_at IS NULL)
  );

-- Admin case data is deliberately separate from the host-shared consultation memo. Event rows retain
-- actor/time/revision only; they never duplicate memo text or guest PII.
CREATE TABLE experience_support_cases (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  assigned_admin_user_id text CHECK (assigned_admin_user_id IS NULL OR length(assigned_admin_user_id) BETWEEN 1 AND 256),
  internal_memo text CHECK (internal_memo IS NULL OR (length(internal_memo) BETWEEN 1 AND 5000 AND internal_memo = btrim(internal_memo))),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by text CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

CREATE TABLE experience_support_case_events (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  actor_admin_user_id text NOT NULL CHECK (length(actor_admin_user_id) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (event_type IN ('ASSIGNEE_CHANGED', 'INTERNAL_MEMO_CHANGED', 'GUEST_CONTACT_SENT', 'SUPPORT_ACTION')),
  revision bigint NOT NULL CHECK (revision > 0),
  command_id uuid,
  action text CHECK (action IS NULL OR action ~ '^SUPPORT_[A-Z_]{1,39}$'),
  outcome text CHECK (outcome IS NULL OR outcome ~ '^[A-Z_]{1,40}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (event_type = 'SUPPORT_ACTION' AND action IS NOT NULL AND outcome IS NOT NULL)
    OR (event_type <> 'SUPPORT_ACTION' AND action IS NULL AND outcome IS NULL)
  ),
  UNIQUE (provider_id, booking_id, command_id, event_type),
  FOREIGN KEY (provider_id, booking_id) REFERENCES experience_support_cases(provider_id, booking_id) ON DELETE RESTRICT
);
CREATE INDEX experience_support_case_events_booking_idx
  ON experience_support_case_events (provider_id, booking_id, occurred_at DESC, id DESC);

-- A support reply is a distinct speaker in the existing booking thread/mail outbox. It is never stored as HOST,
-- which prevents the guest page and host console from presenting NIHO as the provider.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='guest_question_messages'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) ~ '(author|source|command_id|author_niho_user_id|delivery_status|delivery_attempts|lease_until|delivered_at)'
  LOOP
    EXECUTE format('ALTER TABLE guest_question_messages DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE guest_question_messages
  ADD CONSTRAINT guest_question_messages_author_check CHECK (author IN ('GUEST', 'HOST', 'SUPPORT')),
  ADD CONSTRAINT guest_question_messages_source_check CHECK (source IN ('SITE_FORM', 'REPLY_PAGE', 'BOOKING_PAGE', 'HOST_CONSOLE', 'SUPPORT_CONSOLE')),
  ADD CONSTRAINT guest_question_messages_body_length_check CHECK (
    (author = 'GUEST' AND length(body) <= 1000) OR (author IN ('HOST', 'SUPPORT') AND length(body) <= 4000)
  ),
  ADD CONSTRAINT guest_question_messages_author_source_check CHECK (
    (author = 'GUEST' AND source IN ('SITE_FORM', 'REPLY_PAGE', 'BOOKING_PAGE'))
    OR (author = 'HOST' AND source = 'HOST_CONSOLE')
    OR (author = 'SUPPORT' AND source = 'SUPPORT_CONSOLE')
  ),
  ADD CONSTRAINT guest_question_messages_actor_check CHECK ((author IN ('HOST', 'SUPPORT')) = (author_niho_user_id IS NOT NULL)),
  ADD CONSTRAINT guest_question_messages_command_check CHECK ((author IN ('HOST', 'SUPPORT')) = (command_id IS NOT NULL)),
  ADD CONSTRAINT guest_question_messages_request_key_check CHECK ((source IN ('REPLY_PAGE', 'BOOKING_PAGE')) = (client_request_key IS NOT NULL)),
  ADD CONSTRAINT guest_question_messages_delivery_actor_check CHECK ((author IN ('HOST', 'SUPPORT')) = (delivery_status IS NOT NULL)),
  ADD CONSTRAINT guest_question_messages_guest_no_delivery_check CHECK (author IN ('HOST', 'SUPPORT') OR (delivery_attempts = 0 AND lease_until IS NULL AND delivered_at IS NULL)),
  ADD CONSTRAINT guest_question_messages_delivered_check CHECK ((delivery_status = 'SENT') = (delivered_at IS NOT NULL)),
  ADD CONSTRAINT guest_question_messages_sending_lease_check CHECK (delivery_status IS DISTINCT FROM 'SENDING' OR lease_until IS NOT NULL),
  ADD CONSTRAINT guest_question_messages_finished_lease_check CHECK (delivery_status NOT IN ('SENT', 'FAILED') OR lease_until IS NULL);

CREATE FUNCTION experience_support_message_booking_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author = 'SUPPORT' AND NOT EXISTS (
    SELECT 1 FROM guest_question_threads t WHERE t.provider_id=NEW.provider_id AND t.id=NEW.thread_id AND t.booking_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'support messages require a booking thread';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_question_messages_support_booking_only
  BEFORE INSERT OR UPDATE OF author,thread_id ON guest_question_messages
  FOR EACH ROW EXECUTE FUNCTION experience_support_message_booking_only();

CREATE TABLE experience_support_case_commands (
  command_id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  actor_admin_user_id text NOT NULL CHECK (length(actor_admin_user_id) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_revision bigint NOT NULL CHECK (result_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

-- In-app Admin notices are transactionally written with the booking event. Read state belongs to an
-- Admin actor, not the notification itself, so one person's read never hides it from another.
CREATE TABLE experience_support_admin_notifications (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 160),
  topic text NOT NULL CHECK (topic IN ('BOOKING_RECEIVED', 'PAYMENT_REVIEW', 'CANCELLATION_REQUEST', 'BOOKING_CANCELLED', 'REFUND_UPDATED', 'GUEST_MESSAGE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, booking_id, dedupe_key),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);
CREATE INDEX experience_support_admin_notifications_page_idx
  ON experience_support_admin_notifications (created_at DESC, id DESC);

CREATE TABLE experience_support_admin_notification_reads (
  notification_id uuid NOT NULL REFERENCES experience_support_admin_notifications(id) ON DELETE CASCADE,
  admin_user_id text NOT NULL CHECK (length(admin_user_id) BETWEEN 1 AND 256),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (notification_id, admin_user_id)
);
CREATE INDEX experience_support_admin_notification_reads_actor_idx
  ON experience_support_admin_notification_reads (admin_user_id, read_at DESC, notification_id);

-- One current reconciliation snapshot per Experience booking. Immutable booking terms and seller/account
-- come from the booking snapshot; observed Stripe evidence is refreshed without replacing that source.
CREATE TABLE experience_booking_settlements (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  stripe_account_ref text NOT NULL CHECK (stripe_account_ref ~ '^acct_[A-Za-z0-9]{8,}$'),
  stripe_payment_ref text NOT NULL CHECK (stripe_payment_ref ~ '^pi_[A-Za-z0-9_]{8,}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_amount bigint NOT NULL CHECK (gross_amount > 0),
  fee_rate_basis_points integer NOT NULL CHECK (fee_rate_basis_points IN (1000, 1500)),
  support_enabled boolean NOT NULL,
  consent_version text CHECK (consent_version IS NULL OR length(consent_version) BETWEEN 1 AND 64),
  agreement_revision bigint CHECK (agreement_revision IS NULL OR agreement_revision > 0),
  stripe_charge_ref text CHECK (stripe_charge_ref IS NULL OR stripe_charge_ref ~ '^ch_[A-Za-z0-9_]{8,}$'),
  stripe_balance_transaction_ref text CHECK (stripe_balance_transaction_ref IS NULL OR stripe_balance_transaction_ref ~ '^txn_[A-Za-z0-9_]{8,}$'),
  stripe_application_fee_ref text CHECK (stripe_application_fee_ref IS NULL OR stripe_application_fee_ref ~ '^fee_[A-Za-z0-9_]{8,}$'),
  stripe_fee_payer text CHECK (stripe_fee_payer IS NULL OR stripe_fee_payer IN ('ACCOUNT', 'APPLICATION')),
  processing_fee_amount bigint CHECK (processing_fee_amount IS NULL OR processing_fee_amount >= 0),
  processing_fee_currency text CHECK (processing_fee_currency IS NULL OR processing_fee_currency ~ '^[A-Z]{3}$'),
  application_fee_amount bigint CHECK (application_fee_amount IS NULL OR application_fee_amount >= 0),
  application_fee_refunded bigint CHECK (application_fee_refunded IS NULL OR application_fee_refunded >= 0),
  successful_refund_amount bigint CHECK (successful_refund_amount IS NULL OR successful_refund_amount >= 0),
  pending_refund_amount bigint CHECK (pending_refund_amount IS NULL OR pending_refund_amount >= 0),
  failed_refund_count integer CHECK (failed_refund_count IS NULL OR failed_refund_count >= 0),
  compensation_amount bigint CHECK (compensation_amount IS NULL OR compensation_amount >= 0),
  compensation_status text NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (compensation_status IN ('NOT_REQUIRED', 'PREPARED', 'SUBMITTING', 'TRANSFERRED', 'RESULT_UNKNOWN', 'RETRYABLE_FAILED', 'REVIEW_REQUIRED')),
  stripe_transfer_ref text CHECK (stripe_transfer_ref IS NULL OR stripe_transfer_ref ~ '^tr_[A-Za-z0-9_]{8,}$'),
  status text NOT NULL DEFAULT 'PREPARING'
    CHECK (status IN ('PREPARING', 'PROCESSING_COST_PENDING', 'PROCESSING', 'RESULT_UNKNOWN', 'REVIEW_REQUIRED', 'SETTLED')),
  issue_code text CHECK (issue_code IS NULL OR issue_code ~ '^[a-z0-9_]{1,80}$'),
  last_reconciled_at timestamptz,
  next_reconcile_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK ((support_enabled AND fee_rate_basis_points = 1500) OR (NOT support_enabled AND fee_rate_basis_points = 1000)),
  CHECK ((consent_version IS NULL) = (agreement_revision IS NULL)),
  CHECK (successful_refund_amount IS NULL OR successful_refund_amount <= gross_amount),
  CHECK (pending_refund_amount IS NULL OR pending_refund_amount <= gross_amount)
);
CREATE INDEX experience_booking_settlements_reconcile_idx
  ON experience_booking_settlements (next_reconcile_at, updated_at)
  WHERE status IN ('PREPARING', 'PROCESSING_COST_PENDING', 'PROCESSING', 'RESULT_UNKNOWN', 'REVIEW_REQUIRED');

-- A transfer command is recorded before Stripe is called. Its stable UUID is both the idempotency key
-- seed and the reconciliation selector (transfer_group + metadata) after Stripe's v1 key-retention window.
CREATE TABLE experience_settlement_commands (
  command_id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  action text NOT NULL CHECK (action = 'PROCESSING_COST_COMPENSATION'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination_account_ref text NOT NULL CHECK (destination_account_ref ~ '^acct_[A-Za-z0-9]{8,}$'),
  transfer_group text NOT NULL CHECK (length(transfer_group) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('PREPARED', 'SUBMITTING', 'TRANSFERRED', 'RESULT_UNKNOWN', 'RETRYABLE_FAILED', 'REVIEW_REQUIRED')),
  stripe_transfer_ref text CHECK (stripe_transfer_ref IS NULL OR stripe_transfer_ref ~ '^tr_[A-Za-z0-9_]{8,}$'),
  issue_code text CHECK (issue_code IS NULL OR issue_code ~ '^[a-z0-9_]{1,80}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, booking_id) REFERENCES experience_booking_settlements(provider_id, booking_id) ON DELETE RESTRICT
);
CREATE INDEX experience_settlement_commands_latest_idx
  ON experience_settlement_commands (provider_id, booking_id, action, created_at DESC);

-- In-app notices follow the existing booking state transactions. The dedupe key is stable for each event, so webhook
-- retries and refund state refreshes never create duplicate notices. Payloads intentionally carry no guest details.
CREATE FUNCTION experience_support_notice_for_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  notice_topic text;
  notice_key text;
  notice_provider_id text;
  notice_booking_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    notice_provider_id := NEW.provider_id;
    notice_booking_id := NEW.id;
    IF NEW.status = 'CONFIRMED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      notice_topic := 'BOOKING_RECEIVED';
      notice_key := 'booking-confirmed:' || NEW.public_booking_id::text;
    ELSIF NEW.status = 'PAYMENT_REVIEW' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      notice_topic := 'PAYMENT_REVIEW';
      notice_key := 'payment-review:' || NEW.public_booking_id::text;
    ELSIF NEW.status = 'CANCELLED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      notice_topic := 'BOOKING_CANCELLED';
      notice_key := 'booking-cancelled:' || NEW.public_booking_id::text;
    END IF;
  ELSIF TG_TABLE_NAME = 'booking_cancellation_requests' AND TG_OP = 'INSERT' AND NEW.status = 'OPEN' THEN
    notice_provider_id := NEW.provider_id;
    notice_booking_id := NEW.booking_id;
    notice_topic := 'CANCELLATION_REQUEST';
    notice_key := 'cancellation-request:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'booking_refunds' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    notice_provider_id := NEW.provider_id;
    notice_booking_id := NEW.booking_id;
    notice_topic := 'REFUND_UPDATED';
    notice_key := 'refund:' || NEW.id::text || ':' || NEW.status;
  END IF;
  IF notice_topic IS NOT NULL THEN
    INSERT INTO experience_support_admin_notifications (id, provider_id, booking_id, dedupe_key, topic)
    VALUES (gen_random_uuid(), notice_provider_id, notice_booking_id, notice_key, notice_topic)
    ON CONFLICT (provider_id, booking_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_experience_support_notice
  AFTER INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION experience_support_notice_for_booking();
CREATE TRIGGER booking_cancellation_requests_experience_support_notice
  AFTER INSERT ON booking_cancellation_requests
  FOR EACH ROW EXECUTE FUNCTION experience_support_notice_for_booking();
CREATE TRIGGER booking_refunds_experience_support_notice
  AFTER INSERT OR UPDATE OF status ON booking_refunds
  FOR EACH ROW EXECUTE FUNCTION experience_support_notice_for_booking();

-- Only an inbound guest message in a support-enabled booking creates a new-contact notice. The body and identity stay
-- in the existing private booking thread; sending NIHO's own message is not reported as a new guest message.
CREATE FUNCTION experience_support_notice_for_guest_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  booking_row_id bigint;
  fee_snapshot jsonb;
BEGIN
  IF NEW.author <> 'GUEST' THEN RETURN NEW; END IF;
  SELECT t.booking_id,b.pricing_snapshot->'platformFee'
    INTO booking_row_id,fee_snapshot
    FROM guest_question_threads t JOIN bookings b ON b.provider_id=t.provider_id AND b.id=t.booking_id
   WHERE t.provider_id=NEW.provider_id AND t.id=NEW.thread_id;
  IF booking_row_id IS NULL OR COALESCE(fee_snapshot->>'supportEnabled','') <> 'true' OR COALESCE(fee_snapshot->>'basisPoints','') <> '1500'
     OR COALESCE(fee_snapshot->>'supportConsentVersion','') = ''
     OR COALESCE(fee_snapshot->>'supportAgreementRevision','') !~ '^[1-9][0-9]*$' THEN
    RETURN NEW;
  END IF;
  INSERT INTO experience_support_admin_notifications (id,provider_id,booking_id,dedupe_key,topic)
  VALUES (gen_random_uuid(),NEW.provider_id,booking_row_id,'guest-message:' || NEW.id::text,'GUEST_MESSAGE')
  ON CONFLICT (provider_id,booking_id,dedupe_key) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_booking_message_experience_support_notice
  AFTER INSERT ON guest_question_messages
  FOR EACH ROW EXECUTE FUNCTION experience_support_notice_for_guest_message();

-- The existing cancellation command ledger is the operation source of truth. Copy only its actor, action and outcome
-- into the private case timeline; never copy the command fingerprint, cancellation note, message, refund payload or PII.
CREATE FUNCTION experience_support_log_admin_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  public_id uuid;
  booking_row_id bigint;
  next_revision bigint;
BEGIN
  IF NEW.actor_kind <> 'SUPPORT' OR NEW.action NOT IN (
    'SUPPORT_CANCEL', 'SUPPORT_APPROVE', 'SUPPORT_DECLINE', 'SUPPORT_RESOLVE_REVIEW', 'SUPPORT_RETRY_REFUND', 'SUPPORT_CLOSE_REFUND'
  ) OR jsonb_typeof(NEW.result->'bookingIds') <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR public_id IN SELECT value::uuid FROM jsonb_array_elements_text(NEW.result->'bookingIds') AS ids(value)
  LOOP
    SELECT b.id INTO booking_row_id
      FROM bookings b
     WHERE b.provider_id=NEW.provider_id AND b.public_booking_id=public_id
     FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO experience_support_cases (provider_id, booking_id)
      VALUES (NEW.provider_id, booking_row_id) ON CONFLICT DO NOTHING;
    UPDATE experience_support_cases
       SET revision=revision+1, updated_by=NEW.actor_ref, updated_at=clock_timestamp()
     WHERE provider_id=NEW.provider_id AND booking_id=booking_row_id
     RETURNING revision INTO next_revision;
    INSERT INTO experience_support_case_events
      (id,provider_id,booking_id,actor_admin_user_id,event_type,revision,command_id,action,outcome)
    VALUES
      (gen_random_uuid(),NEW.provider_id,booking_row_id,NEW.actor_ref,'SUPPORT_ACTION',next_revision,NEW.command_id,NEW.action,NEW.result->>'outcome')
    ON CONFLICT (provider_id,booking_id,command_id,event_type) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_cancellation_commands_support_history
  AFTER INSERT ON booking_cancellation_commands
  FOR EACH ROW EXECUTE FUNCTION experience_support_log_admin_operation();

COMMIT;
