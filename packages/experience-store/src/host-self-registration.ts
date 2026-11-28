import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { grantProviderOwnerIn, hostEmail, lockHostOwnerIn } from "./host-accounts.ts";
import { requestHostNotificationAddressChangeIn, type HostNotificationAddressChange } from "./host-notification-addresses.ts";
import { assertSelfRegistrationPublicName } from "./provider-public-name.ts";
import type { DbRow } from "./rows.ts";

/*
 * 自分でホスト登録する (Epic #700, #707): the provider (`prv_`), its media state, its public name the OWNER consented to, the
 * OWNER membership, the host-terms acceptance and the first notification address, written in the caller's transaction by
 * HostAccountIdentities.registerHostSelf / registerHostSelfForAccount. Nothing here opens its own transaction: either every row
 * stays or none does.
 */

export type SelfRegistrationProviderKind = "PERSON" | "BUSINESS";

export interface SelfRegistrationInput {
  readonly providerKind: SelfRegistrationProviderKind;
  /** The Japanese name (required). */
  readonly publicDisplayName: string;
  /** The English name; none shows the Japanese one on the English site. */
  readonly publicDisplayNameEn?: string | null;
  /** The version of the host terms the person agreed to. */
  readonly hostTermsVersion: string;
  /** Where bookings and questions go. Asked to confirm; never stored as a sign-in address. */
  readonly notificationEmail: string;
}

export interface ValidSelfRegistrationInput {
  readonly providerKind: SelfRegistrationProviderKind;
  readonly publicDisplayName: string;
  readonly publicDisplayNameEn: string | null;
  readonly hostTermsVersion: string;
  readonly notificationEmail: string;
}

export type SelfRegisteredProvider =
  | {
    readonly kind: "registered";
    readonly providerId: string;
    /** What asking for the confirmation email did (PENDING for an address nobody has confirmed yet). */
    readonly notificationAddress: HostNotificationAddressChange["kind"];
  }
  /** The account is already the active OWNER of HOST_PROVIDER_OWNER_LIMIT providers. */
  | { readonly kind: "owner-limit-reached" }
  /** No such account or it is not ACTIVE. */
  | { readonly kind: "account-suspended" };

/** Thrown inside the transaction for an answer that must leave nothing behind; the caller turns it back into the value. */
export class SelfRegistrationRefused extends StoreError {
  readonly result: Exclude<SelfRegisteredProvider, { readonly kind: "registered" }>;

  constructor(result: Exclude<SelfRegisteredProvider, { readonly kind: "registered" }>) {
    super("The registration was refused; nothing was written.");
    this.name = "SelfRegistrationRefused";
    this.result = result;
  }
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Checks the whole input before any transaction: names (with the reserved words), kind, terms version, address. */
export function validateSelfRegistrationInput(input: SelfRegistrationInput): ValidSelfRegistrationInput {
  if (input?.providerKind !== "PERSON" && input?.providerKind !== "BUSINESS") throw new StoreValidationError("providerKind must be PERSON or BUSINESS.");
  const publicDisplayName = assertSelfRegistrationPublicName(input.publicDisplayName, "publicDisplayName");
  const english = input.publicDisplayNameEn;
  const publicDisplayNameEn = english === undefined || english === null || english === "" ? null : assertSelfRegistrationPublicName(english, "publicDisplayNameEn");
  const terms = input.hostTermsVersion;
  if (typeof terms !== "string" || terms.length < 1 || terms.length > 160 || terms !== terms.trim() || CONTROL.test(terms)) {
    throw new StoreValidationError("hostTermsVersion must be 1-160 characters.");
  }
  return { providerKind: input.providerKind, publicDisplayName, publicDisplayNameEn, hostTermsVersion: terms, notificationEmail: hostEmail(input.notificationEmail).email };
}

/**
 * Registers a new provider for an ACTIVE host account, inside the caller's transaction (`input` already validated). The
 * account's owner lock comes first, then the rows, and the OWNER goes through grantProviderOwnerIn, the one place the limit
 * is judged. For anything but `registered` the rows written so far are still in the transaction: the caller must roll
 * back (throw SelfRegistrationRefused). A rate-limited confirmation email throws StoreRateLimitedError, which rolls back too.
 */
export async function createSelfRegisteredProviderIn(
  client: PoolClient,
  input: { readonly hostAccountId: string; readonly input: ValidSelfRegistrationInput; readonly at: string },
): Promise<SelfRegisteredProvider> {
  const { hostAccountId, at } = input;
  const details = input.input;
  await lockHostOwnerIn(client, hostAccountId);
  const account = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id = $1 FOR SHARE", [hostAccountId]);
  if (account.rows[0]?.status !== "ACTIVE") return { kind: "account-suspended" };
  const providerId = `prv_${randomUUID().replaceAll("-", "")}`;
  await client.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
  await client.query("INSERT INTO experience_provider_media_state (provider_id) VALUES ($1)", [providerId]);
  await client.query(
    `INSERT INTO experience_provider_public_profiles
       (provider_id,public_display_name,public_display_name_en,provider_kind,consent_version,consented_at,consent_source,consented_by_host_account_id,consented_by_admin_niho_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,'OWNER',$7,NULL)`,
    [providerId, details.publicDisplayName, details.publicDisplayNameEn, details.providerKind, details.hostTermsVersion, at, hostAccountId],
  );
  const granted = await grantProviderOwnerIn(client, { providerId, hostAccountId, nowUtc: at });
  if (granted.kind === "owner-limit-reached") return { kind: "owner-limit-reached" };
  if (granted.kind === "host-account-not-active") return { kind: "account-suspended" };
  if (granted.kind !== "granted") throw new StoreError(`A new provider could not be given its OWNER (${granted.kind}).`);
  await client.query(
    `INSERT INTO experience_provider_self_registrations (provider_id,host_account_id,host_terms_version,host_terms_accepted_at)
     VALUES ($1,$2,$3,$4::timestamptz)`,
    [providerId, hostAccountId, details.hostTermsVersion, at],
  );
  // The memberships' column still holds the host account ID (`hst_`), as for every host; the address is not a sign-in address.
  const change = await requestHostNotificationAddressChangeIn(client, { nihoUserId: hostAccountId, providerId, email: details.notificationEmail });
  return { kind: "registered", providerId, notificationAddress: change.kind };
}
