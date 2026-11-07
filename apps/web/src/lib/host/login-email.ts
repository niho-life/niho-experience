import "server-only";
import type { HostNotificationAddresses } from "@niho-experience/experience-store";
import { hostNotificationAddresses } from "@/lib/experience/store-server";
import { verifiedEmailFromIdToken } from "./id-token-email";

/**
 * ホストへのメールの宛先 (#194, owner decision 2026-11-01): at a /host sign-in, the NIHO account's verified address is copied
 * into the experience DB for this NIHO user (an unverified or missing one clears the earlier copy). Only while
 * EXPERIENCE_HOST_MAIL_ENABLED is on. The sign-in never waits on it failing: the error's class name is logged, never the
 * address or the token.
 */
/**
 * The same for an Experience host account (ADR 0003): opening the emailed link proved the address, so it becomes the
 * sign-in's copy for this host account (`hst_` in the `niho_user_id` key). `invitation` when the sign-in returns to a
 * product operator's invitation (kept for a day before the grant exists). Never waits on failing; logs the class only.
 */
export async function recordHostAccountLoginEmail(
  input: { readonly hostAccountId: string; readonly email: string; readonly invitation: boolean },
  addresses: () => Pick<HostNotificationAddresses, "recordLogin"> | null = hostNotificationAddresses,
): Promise<void> {
  try {
    const store = addresses();
    if (!store) return;
    await store.recordLogin({ nihoUserId: input.hostAccountId, verifiedEmail: input.email, invitation: input.invitation });
  } catch (error) {
    console.error(`[host-auth] sign-in address not copied: ${error instanceof Error ? error.name : "unknown error"}`);
  }
}

export async function copyLoginEmail(
  input: { readonly nihoUserId: string; readonly idToken: string; readonly invitation: boolean },
  addresses: () => Pick<HostNotificationAddresses, "recordLogin"> | null = hostNotificationAddresses,
): Promise<void> {
  try {
    const store = addresses();
    if (!store) return;
    await store.recordLogin({ nihoUserId: input.nihoUserId, verifiedEmail: verifiedEmailFromIdToken(input.idToken, input.nihoUserId), invitation: input.invitation });
  } catch (error) {
    console.error(`[host-auth] sign-in address not copied: ${error instanceof Error ? error.name : "unknown error"}`);
  }
}
