import type { Pool } from "pg";

/**
 * A sign-in address for each of these people (the host emails' destination, host_notification_addresses). A provider's page can be
 * published only when one of its OWNERs has one (NOTIFICATION_ADDRESS_REQUIRED, #708). Synthetic addresses only.
 */
export async function seedNotificationAddresses(pool: Pool, ...userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    await pool.query(
      "INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,$2,clock_timestamp()) ON CONFLICT (niho_user_id) DO NOTHING",
      [userId, `${userId.replace(/[^a-z0-9]+/gi, "-")}@example.test`],
    );
  }
}
