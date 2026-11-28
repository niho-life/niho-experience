BEGIN;

-- #732: pin the search_path of the trigger functions that 0092 to 0097 left without one (0099 already pins its own).
-- A role that may create temporary tables could otherwise shadow a table the function reads (a count in 0093, the consent
-- lookup in 0096, an UPDATE in 0097) with an empty table of its own in pg_temp and pass the check. With pg_temp last, a name
-- is looked up in pg_catalog and public first and never in the temporary schema first. Only the setting is added: no function
-- body changes, and its unqualified names resolve to the same public tables.

ALTER FUNCTION require_booking_publication_is_sale_version() SET search_path = pg_catalog, public, pg_temp; -- 0092
ALTER FUNCTION require_status_matches_booking_publication() SET search_path = pg_catalog, public, pg_temp; -- 0092
ALTER FUNCTION reject_experience_booking_event_mutation() SET search_path = pg_catalog, public, pg_temp; -- 0092
ALTER FUNCTION reject_experience_provider_self_registration_mutation() SET search_path = pg_catalog, public, pg_temp; -- 0093
ALTER FUNCTION enforce_host_provider_owner_limit() SET search_path = pg_catalog, public, pg_temp; -- 0093
ALTER FUNCTION protect_booking_snapshots() SET search_path = pg_catalog, public, pg_temp; -- 0094
ALTER FUNCTION reject_booking_change_mutation() SET search_path = pg_catalog, public, pg_temp; -- 0094
ALTER FUNCTION protect_experience_connect_accounts() SET search_path = pg_catalog, public, pg_temp; -- 0095
ALTER FUNCTION protect_provider_agent_sales_consents() SET search_path = pg_catalog, public, pg_temp; -- 0096
ALTER FUNCTION experience_agent_payouts_append_only() SET search_path = pg_catalog, public, pg_temp; -- 0097
ALTER FUNCTION experience_agent_payouts_protect() SET search_path = pg_catalog, public, pg_temp; -- 0097
ALTER FUNCTION experience_agent_adjustments_protect() SET search_path = pg_catalog, public, pg_temp; -- 0097
ALTER FUNCTION experience_queue_agent_payout_check() SET search_path = pg_catalog, public, pg_temp; -- 0097
ALTER FUNCTION experience_queue_agent_payout_check_for_provider() SET search_path = pg_catalog, public, pg_temp; -- 0097

COMMIT;
