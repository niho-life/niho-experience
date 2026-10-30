import { expandOccurrences, type Occurrence } from "@niho-experience/experience-domain";
import type { PoolClient } from "pg";
import { StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { overrideFromRow, salesStateFromRow, scheduleRuleFromRow, type DbRow } from "./rows.ts";

const RULE_COLUMNS = `provider_id,id,product_id,time_zone,starts_on::text AS starts_on,ends_on::text AS ends_on,
  to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,capacity,booking_cutoff_minutes,
  busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence,version`;

/** Resolves a stored listing occurrence from the live rule/override/sales rows. */
export async function currentChannelOccurrence(
  client: PoolClient,
  providerId: string,
  listingId: string,
  occurrenceId: string,
): Promise<Occurrence> {
  const marker = occurrenceId.lastIndexOf("@");
  if (marker < 1) throw new StoreValidationError("occurrenceId is invalid.");
  let ruleId: string;
  try { ruleId = decodeURIComponent(occurrenceId.slice(0, marker)); }
  catch (error) { throw new StoreValidationError("occurrenceId is invalid.", { cause: error }); }
  const sourceDate = occurrenceId.slice(marker + 1);
  const ruleResult = await client.query<DbRow>(
    `SELECT ${RULE_COLUMNS} FROM schedule_rules r
      WHERE r.provider_id=$1 AND r.id=$3 AND EXISTS (
        SELECT 1 FROM channel_listings l WHERE l.provider_id=r.provider_id AND l.product_id=r.product_id AND l.id=$2
      )`,
    [providerId, listingId, ruleId],
  );
  if (!ruleResult.rows[0]) throw new StoreNotFoundError("schedule rule");
  const storedRule = scheduleRuleFromRow(ruleResult.rows[0]);
  const overrideResult = await client.query<DbRow>(
    `SELECT occurrence_id,kind,local_date::text AS local_date,to_char(local_start_time,'HH24:MI') AS local_start_time,duration_minutes,version
       FROM schedule_occurrence_overrides WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3`,
    [providerId, ruleId, occurrenceId],
  );
  const salesResult = await client.query<DbRow>(
    "SELECT occurrence_id,desired_state,version FROM schedule_occurrence_sales_states WHERE provider_id=$1 AND rule_id=$2 AND occurrence_id=$3",
    [providerId, ruleId, occurrenceId],
  );
  const override = overrideResult.rows[0] ? overrideFromRow(overrideResult.rows[0]).override : undefined;
  const sales = salesResult.rows[0] ? salesStateFromRow(salesResult.rows[0]).state : undefined;
  const targetDate = override?.kind === "RESCHEDULE" ? override.localDate : sourceDate;
  const occurrence = expandOccurrences({
    rule: storedRule.rule,
    overrides: override ? [override] : [],
    salesStates: sales ? [sales] : [],
    fromDate: targetDate,
    toDate: targetDate,
  }).find((candidate) => candidate.id === occurrenceId);
  if (!occurrence) throw new StoreNotFoundError("schedule occurrence");
  return occurrence;
}
