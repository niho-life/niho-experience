import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Calendar delivery is deliberately separate from the notification outbox. */
export async function enqueueCalendarRecalculation(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly cause: string;
    readonly availableAtUtc?: string;
    readonly commandId?: string;
  },
): Promise<string> {
  const commandId = input.commandId ?? randomUUID();
  const result = { aggregateId: input.aggregateId, version: 1 };
  const payload = {
    providerId: input.providerId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    cause: input.cause,
  };
  await client.query(
    `INSERT INTO calendar_commands (provider_id,command_id,action,request_fingerprint,result)
     VALUES ($1,$2::uuid,'inventory.recalculate',$3,$4::jsonb)`,
    [input.providerId, commandId, JSON.stringify(payload), JSON.stringify(result)],
  );
  await client.query(
    `INSERT INTO calendar_outbox_events
       (provider_id,command_id,aggregate_type,aggregate_id,topic,payload,available_at)
     VALUES ($1,$2::uuid,$3,$4,'calendar.changed',$5::jsonb,COALESCE($6::timestamptz,clock_timestamp()))`,
    [input.providerId, commandId, input.aggregateType, input.aggregateId, JSON.stringify(payload), input.availableAtUtc ?? null],
  );
  return commandId;
}
