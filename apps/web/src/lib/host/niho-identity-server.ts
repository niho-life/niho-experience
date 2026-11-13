import "server-only";
import type { NihoIdentityStatus } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccountIdentities } from "@/lib/experience/store-server";
import { HOST_EMAIL_SIGN_IN_PATH, hostNihoReauthPath, withQuery } from "./routes";

/**
 * The binding of a host account's NIHO account, for 設定 and for the sign-in a sensitive change asks for again (Epic #591,
 * #595). `null`: nothing is bound; `"error"`: the store could not say. Never carries the NIHO user ID.
 */
export async function loadNihoIdentityStatus(hostAccountId: string, store = hostAccountIdentities()): Promise<NihoIdentityStatus | null | "error"> {
  if (!store) return "error";
  try { return await store.readNihoIdentity({ hostAccountId }); }
  catch { return "error"; }
}

/**
 * Where a host whose last sign-in is too old for a sensitive change signs in again, then returns to `returnTo` (an
 * allowlisted page): NIHO's own login when the host signs in with a bound NIHO account (the recent sign-in is read from
 * NIHO's), the emailed link otherwise (the migration fallback, and any host nothing is bound to).
 */
export async function reauthenticationHref(hostAccountId: string, returnTo: string, store?: ReturnType<typeof hostAccountIdentities>): Promise<string> {
  const email = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: returnTo });
  if (!config.hostNihoLoginEnabled) return email;
  const status = await loadNihoIdentityStatus(hostAccountId, store ?? hostAccountIdentities());
  return status !== null && status !== "error" ? hostNihoReauthPath(returnTo) : email;
}
