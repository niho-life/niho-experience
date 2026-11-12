BEGIN;

-- 団体・個別の相談 (#532, v0). A person, a company, a school or a would-be host writes to NIHO before anything is
-- booked: this is the office's inbox, not a booking. It holds no inventory, payment or booking reference, and it is
-- not the 予約前の質問 (guest_question_*, #52), which belongs to one published product and its host.
--
-- The contact details and what the person wrote stay in this table and in the two emails below. They never reach a
-- URL, an analytics event, a log or an outbox payload. Only the Admin console reads them (docs/group-inquiry.md).
-- Retention and deletion are by hand in v0 (docs/group-inquiry.md); nothing here deletes by itself.
CREATE TABLE group_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the sender is shown and quotes back: "IQ-" and 8 letters/digits.
  inquiry_ref text NOT NULL UNIQUE CHECK (inquiry_ref ~ '^IQ-[0-9A-HJKMNP-TV-Z]{8}$'),
  -- A browser's key for one submission: the same form sent again (a lost answer, a double tap) is one inquiry.
  client_request_key text NOT NULL UNIQUE CHECK (length(client_request_key) BETWEEN 8 AND 120),
  kind text NOT NULL CHECK (kind IN ('PERSONAL', 'CORPORATE', 'SCHOOL', 'LISTING')),
  locale text NOT NULL CHECK (locale IN ('ja', 'en')),
  contact_name text NOT NULL CHECK (
    length(contact_name) BETWEEN 1 AND 100 AND contact_name = btrim(contact_name) AND contact_name !~ '[[:cntrl:]]'
  ),
  contact_email text NOT NULL CHECK (
    length(contact_email) BETWEEN 3 AND 254 AND contact_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  -- lower(contact_email): only counts one address's inquiries for the rate limit.
  contact_email_key text NOT NULL CHECK (contact_email_key = lower(contact_email)),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  -- The optional answers that depend on the kind (organization, people, timing, budget and its unit, ...). The store
  -- keeps only the keys its field list names for the kind (group-inquiry-fields.ts); every value is a short string.
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND length(details::text) <= 8000),
  -- Where the sender came from, as far as the page knew. Free text the sender's browser supplied: displayed as text only.
  entry text NOT NULL DEFAULT 'DIRECT' CHECK (entry IN ('DIRECT', 'EXPERIENCE', 'PROVIDER', 'SCHOOL', 'CORPORATE', 'LISTING')),
  interest_experience_slug text CHECK (interest_experience_slug IS NULL OR length(interest_experience_slug) BETWEEN 1 AND 160),
  interest_experience_title text CHECK (interest_experience_title IS NULL OR length(interest_experience_title) BETWEEN 1 AND 200),
  interest_host_name text CHECK (interest_host_name IS NULL OR length(interest_host_name) BETWEEN 1 AND 100),
  utm_source text CHECK (utm_source IS NULL OR length(utm_source) <= 64),
  utm_medium text CHECK (utm_medium IS NULL OR length(utm_medium) <= 64),
  utm_campaign text CHECK (utm_campaign IS NULL OR length(utm_campaign) <= 64),
  -- The office's side, edited by hand in the Admin console. assignee_label is the person at NIHO who handles the
  -- inquiry (text, not a login), and is not the experience's host or 担当 (#535).
  -- The date the sender was told to expect a first answer by (Asia/Tokyo; two business days, fixed when it was kept).
  reply_by_on date NOT NULL,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_PROGRESS', 'DONE')),
  assignee_label text CHECK (assignee_label IS NULL OR (length(assignee_label) BETWEEN 1 AND 100 AND assignee_label !~ '[[:cntrl:]]')),
  next_due_on date,
  staff_note text CHECK (staff_note IS NULL OR length(staff_note) BETWEEN 1 AND 4000),
  -- The Admin actor ID (adm_...) of the last edit. No other history in v0.
  updated_by_actor text CHECK (updated_by_actor IS NULL OR length(updated_by_actor) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The office list: open inquiries first, then by due date, newest first within a day.
CREATE INDEX group_inquiries_list_idx ON group_inquiries (status, next_due_on, created_at DESC);
-- Rate limits: one address, and everyone, in the last hour.
CREATE INDEX group_inquiries_rate_email_idx ON group_inquiries (contact_email_key, created_at);
CREATE INDEX group_inquiries_rate_all_idx ON group_inquiries (created_at);

-- The two emails of one inquiry: the office's notice and the receipt to the sender. Separate rows so a failed
-- notice shows in the Admin list apart from the (accepted) inquiry, and one failing does not hold the other.
-- Delivered by the mail job (POST /internal/experience-jobs/v1/drain): it claims a PENDING row (or a SENDING one
-- whose lease ran out) with a lease, then reports SENT, RETRY (back to PENDING after 2, 4, 8, 16 minutes) or FAILED.
CREATE TABLE group_inquiry_mails (
  inquiry_id uuid NOT NULL REFERENCES group_inquiries(id) ON DELETE CASCADE,
  recipient text NOT NULL CHECK (recipient IN ('STAFF', 'SENDER')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (inquiry_id, recipient)
);

CREATE INDEX group_inquiry_mails_due_idx ON group_inquiry_mails (created_at) WHERE status IN ('PENDING', 'SENDING');

COMMIT;
