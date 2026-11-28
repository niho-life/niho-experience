import "server-only";
import { readExperienceHostSession } from "./accounts";
import { readRegistration } from "./server";
import type { ExperienceHostSession, HostRegistrationState } from "./session";

/*
 * 自分でホスト登録する (Epic #700, #708): who is registering. The screen (/host/start) and the API (POST /host/api/registration)
 * ask the same question of the same two cookies, so the answer lives here once:
 *
 * - a valid sealed registration cookie (NIHO verified a NIHO account no host account is bound to, within 30 minutes): `niho`;
 * - else the Experience session of a host account (a writer, a member of another host, or someone who already owns hosts):
 *   `account`, and the registration adds a host to the account they have. How many hosts one account may own is the store's
 *   rule (HOST_PROVIDER_OWNER_LIMIT, `owner-limit-reached`), not decided here (#709);
 * - else nobody: they sign in first.
 *
 * The cookie wins over a session: what NIHO just proved is who is registering, whoever else is signed in in this browser.
 */
export type RegistrationSource =
  | { readonly kind: "niho"; readonly registration: HostRegistrationState }
  | { readonly kind: "account"; readonly session: ExperienceHostSession };

export async function readRegistrationSource(cookies: { readonly registration: string | undefined; readonly session: string | undefined }, now = Date.now()): Promise<RegistrationSource | null> {
  const registration = readRegistration(cookies.registration, now);
  if (registration) return { kind: "niho", registration };
  const session = await readExperienceHostSession(cookies.session);
  if (!session) return null;
  return { kind: "account", session };
}
