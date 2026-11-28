import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { sellerOwnerSql } from "./host-sellers.ts";
import { agentPlanSql, countedAgentConsentSql } from "./sales-kind.ts";
import { lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

export type SellerKind = "PERSON" | "BUSINESS";
export type SellerDisclosureMethod = "NATIVE" | "EXTERNAL" | "WITHDRAWN";

export type NativeSellerDisclosureInput = {
  readonly method: "NATIVE";
  readonly sellerKind: SellerKind;
  readonly sellerDisplayName: string;
  readonly representativeName: string | null;
  readonly publicAddress: string;
  readonly publicPhone: string;
  readonly publicEmail: string;
  readonly consentVersion: string;
  readonly accepted: true;
};

/** 外部の販売者表示URL（EXTERNAL）は新規保存できない。既存行は SellerDisclosureState でのみ読める。 */
export type SellerDisclosureInput = NativeSellerDisclosureInput;

export type SellerDisclosureState = {
  readonly version: number;
  readonly method: SellerDisclosureMethod;
  readonly sellerKind: SellerKind;
  readonly sellerDisplayName: string;
  readonly representativeName: string | null;
  readonly publicAddress: string | null;
  readonly publicPhone: string | null;
  readonly publicEmail: string | null;
  readonly externalUrl: string | null;
  readonly consentVersion: string;
  readonly consentedAtUtc: string;
  readonly withdrawnAtUtc: string | null;
};

export type HostSellerDisclosure = {
  /** Operator-provisioned legal seller name. The browser cannot replace it (empty for a host with no seller profile, below). */
  readonly sellerDisplayName: string;
  readonly disclosure: SellerDisclosureState | null;
  /**
   * True for a host with no seller profile (#725): it names itself, and the name is fixed once it sells with 代理受領. False
   * (and absent from old readers' view) for a seller whose legal name the operator provisioned.
   */
  readonly nameEditable?: boolean;
};

/** What the OWNER's routes pass: the host with no seller profile may keep a public disclosure for 代理受領 (flag EXPERIENCE_HOST_AGENT_SALES_ENABLED). */
export type SellerDisclosureOptions = { readonly agentSales?: boolean };

export type PublicSellerDisclosure = {
  readonly method: "NATIVE";
  readonly sellerKind: SellerKind;
  readonly sellerDisplayName: string;
  readonly representativeName: string | null;
  readonly publicAddress: string;
  readonly publicPhone: string;
  readonly publicEmail: string;
};

export type SaveSellerDisclosureCommand = {
  readonly commandId: string;
  readonly expectedVersion: number | null;
  readonly disclosure: SellerDisclosureInput;
};

export type WithdrawSellerDisclosureCommand = {
  readonly commandId: string;
  readonly expectedVersion: number;
};

type DbRow = Record<string, unknown>;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001F\u007F]/;
const ADDRESS_CONTROL = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;
const PHONE = /^\+?[0-9 ()-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, name: string, max: number, control = CONTROL): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value || control.test(value)) {
    throw new StoreValidationError(`${name} is invalid.`);
  }
  return value;
}

/** Store-level validation is also used by the strict HTTP parser tests. It never invents missing public values. */
export function validateSellerDisclosureInput(input: SellerDisclosureInput): SellerDisclosureInput {
  if (input.method !== "NATIVE") throw new StoreValidationError("method is invalid.");
  if (input.sellerKind !== "PERSON" && input.sellerKind !== "BUSINESS") throw new StoreValidationError("sellerKind is invalid.");
  const sellerDisplayName = text(input.sellerDisplayName, "sellerDisplayName", 300);
  const consentVersion = text(input.consentVersion, "consentVersion", 160);
  if (input.accepted !== true) throw new StoreValidationError("Public disclosure consent is required.");
  const representativeName = input.sellerKind === "BUSINESS"
    ? text(input.representativeName, "representativeName", 200)
    : input.representativeName === null ? null : (() => { throw new StoreValidationError("A person disclosure cannot set representativeName."); })();
  const publicPhone = text(input.publicPhone, "publicPhone", 40);
  const publicEmail = text(input.publicEmail, "publicEmail", 254);
  if (!PHONE.test(publicPhone)) throw new StoreValidationError("publicPhone is invalid.");
  if (!EMAIL.test(publicEmail)) throw new StoreValidationError("publicEmail is invalid.");
  return {
    method: "NATIVE", sellerKind: input.sellerKind, sellerDisplayName, representativeName,
    publicAddress: text(input.publicAddress, "publicAddress", 500, ADDRESS_CONTROL).replace(/\r\n?/g, "\n"), publicPhone, publicEmail, consentVersion, accepted: true,
  };
}

function validCommand(commandId: string): void {
  if (!UUID_V4.test(commandId)) throw new StoreValidationError("commandId must be a UUID v4.");
}

function instant(value: unknown): string { return new Date(value as string | Date).toISOString(); }
function nullableText(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }

function stateFromRow(row: DbRow): SellerDisclosureState {
  return {
    version: Number(row.version), method: String(row.method) as SellerDisclosureMethod,
    sellerKind: String(row.seller_kind) as SellerKind, sellerDisplayName: String(row.seller_display_name),
    representativeName: nullableText(row.representative_name), publicAddress: nullableText(row.public_address),
    publicPhone: nullableText(row.public_phone), publicEmail: nullableText(row.public_email), externalUrl: nullableText(row.external_url),
    consentVersion: String(row.consent_version), consentedAtUtc: instant(row.consented_at), withdrawnAtUtc: row.withdrawn_at ? instant(row.withdrawn_at) : null,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

type OwnerSeller = { readonly sellerDisplayName: string; readonly sellerNihoAccountRef: string; readonly stripeConnectAccountRef: string };
/** `null` fields: the host has no seller profile and names itself (代理受領, #725). */
type OwnerSellerOrSelf = OwnerSeller | { readonly sellerDisplayName: null; readonly sellerNihoAccountRef: null; readonly stripeConnectAccountRef: null };

const CURRENT_SALES_PLAN = `
  LEFT JOIN experience_product_sales_plan_states sales ON sales.provider_id=state.provider_id AND sales.product_id=state.product_id
  LEFT JOIN experience_product_sales_plan_versions plan ON plan.provider_id=sales.provider_id AND plan.product_id=sales.product_id
    AND plan.revision=sales.current_revision`;

async function ownerSeller(client: PoolClient, actor: HostActor, options: SellerDisclosureOptions = {}): Promise<OwnerSellerOrSelf> {
  assertStoreIdentifier(actor.providerId, "providerId");
  assertStoreIdentifier(actor.nihoUserId, "nihoUserId");
  const found = await client.query<DbRow>(
    `SELECT profile.seller_display_name,profile.seller_niho_account_ref,profile.stripe_connect_account_ref
       FROM provider_memberships membership
       JOIN experience_host_seller_profiles profile ON profile.provider_id=membership.provider_id
      WHERE membership.provider_id=$1 AND membership.niho_user_id=$2
        AND membership.active=true AND membership.role='OWNER'
        AND ${sellerOwnerSql("membership", "profile")}
      FOR SHARE OF membership,profile`,
    [actor.providerId, actor.nihoUserId],
  );
  if (found.rows[0] === undefined) {
    if (options.agentSales !== true) throw new StoreAccessDeniedError();
    // No seller profile at all, and the actor is an active OWNER signed in with an ACTIVE host account.
    const sellerless = await client.query(
      `SELECT 1 FROM provider_memberships membership
         JOIN host_accounts account ON account.id=membership.niho_user_id AND account.status='ACTIVE'
        WHERE membership.provider_id=$1 AND membership.niho_user_id=$2 AND membership.active=true AND membership.role='OWNER'
          AND NOT EXISTS (SELECT 1 FROM experience_host_seller_profiles profile WHERE profile.provider_id=membership.provider_id)
        FOR SHARE OF membership,account`,
      [actor.providerId, actor.nihoUserId],
    );
    if (sellerless.rows[0] === undefined) throw new StoreAccessDeniedError();
    return { sellerDisplayName: null, sellerNihoAccountRef: null, stripeConnectAccountRef: null };
  }
  return {
    sellerDisplayName: String(found.rows[0].seller_display_name),
    sellerNihoAccountRef: String(found.rows[0].seller_niho_account_ref),
    stripeConnectAccountRef: String(found.rows[0].stripe_connect_account_ref),
  };
}

/**
 * 代理受領 (#725): while a product sold with 代理受領 is taking bookings, its public seller name is the name on its bookings and
 * its sales-plan revision, so it is not changed or withdrawn. The host stops bookings first.
 */
async function agentSalesOpen(client: PoolClient, providerId: string): Promise<boolean> {
  const open = await client.query(
    `SELECT 1
       FROM experience_product_publication_states state
       ${CURRENT_SALES_PLAN}
      WHERE state.provider_id=$1 AND state.booking_publication_id IS NOT NULL AND state.self_stopped_at IS NULL
        AND state.operations_suspended_at IS NULL AND state.owner_resume_required=false
        AND ${agentPlanSql("plan")}
      LIMIT 1`,
    [providerId],
  );
  return (open.rowCount ?? 0) > 0;
}

async function activePublicationsMatchSeller(client: PoolClient, actor: HostActor, seller: OwnerSeller): Promise<void> {
  const mismatch = await client.query(
    `SELECT 1
       FROM experience_product_publication_states state
       JOIN experience_product_publications publication
         ON publication.id=state.booking_publication_id
        AND publication.provider_id=state.provider_id AND publication.product_id=state.product_id
       ${CURRENT_SALES_PLAN}
      WHERE state.provider_id=$1 AND state.self_stopped_at IS NULL AND state.operations_suspended_at IS NULL
        AND state.owner_resume_required=false
        AND (plan.charge_mode IS NULL OR plan.charge_mode='CONNECT_DIRECT')
        AND (COALESCE(plan.seller_display_name,publication.seller_display_name)<>$2
          OR COALESCE(plan.seller_niho_account_ref,publication.seller_niho_account_ref)<>$3
          OR COALESCE(plan.stripe_account_ref,publication.stripe_connect_account_ref)<>$4)
      LIMIT 1`,
    [actor.providerId, seller.sellerDisplayName, seller.sellerNihoAccountRef, seller.stripeConnectAccountRef],
  );
  if (mismatch.rows[0]) throw new StoreConflictError("An active publication does not match the provisioned legal seller and payment recipient.");
}

async function previousResult(client: PoolClient, actor: HostActor, commandId: string, requestFingerprint: string): Promise<SellerDisclosureState | null> {
  const result = await client.query<DbRow>(
    `SELECT actor_niho_user_id,request_fingerprint,applied_version FROM provider_seller_disclosure_commands
      WHERE provider_id=$1 AND command_id=$2`,
    [actor.providerId, commandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.actor_niho_user_id !== actor.nihoUserId || row.request_fingerprint !== requestFingerprint) {
    throw new StoreConflictError("commandId was already used for another seller disclosure request or actor.");
  }
  const current = await client.query<DbRow>(
    "SELECT * FROM provider_seller_disclosures WHERE provider_id=$1",
    [actor.providerId],
  );
  if (!current.rows[0] || Number(current.rows[0].version) !== Number(row.applied_version)) {
    throw new StoreConflictError("Seller disclosure command was superseded; read the current value again.");
  }
  return stateFromRow(current.rows[0]);
}

async function recordResult(
  client: PoolClient,
  actor: HostActor,
  commandId: string,
  action: "SAVE" | "WITHDRAW",
  requestFingerprint: string,
  appliedVersion: number,
): Promise<void> {
  await client.query(
    `INSERT INTO provider_seller_disclosure_commands
       (provider_id,command_id,actor_niho_user_id,action,request_fingerprint,applied_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.providerId, commandId, actor.nihoUserId, action, requestFingerprint, appliedVersion],
  );
}

/** Serialize this provider even before its first row exists, so concurrent first saves cannot both satisfy expectedVersion=null. */
async function lockProviderDisclosure(client: PoolClient, providerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`provider-seller-disclosure:${providerId}`]);
}

export class ProviderSellerDisclosureRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async getForOwner(actor: HostActor, options: SellerDisclosureOptions = {}): Promise<HostSellerDisclosure> {
    return withTransaction(this.#pool, async (client) => {
      const seller = await ownerSeller(client, actor, options);
      const result = await client.query<DbRow>("SELECT * FROM provider_seller_disclosures WHERE provider_id=$1", [actor.providerId]);
      const disclosure = result.rows[0] ? stateFromRow(result.rows[0]) : null;
      if (seller.sellerDisplayName === null) {
        const fixed = disclosure?.method === "NATIVE" && await agentSalesOpen(client, actor.providerId);
        return { sellerDisplayName: disclosure?.method === "NATIVE" ? disclosure.sellerDisplayName : "", disclosure, nameEditable: !fixed };
      }
      return { sellerDisplayName: seller.sellerDisplayName, disclosure };
    });
  }

  async save(actor: HostActor, command: SaveSellerDisclosureCommand, options: SellerDisclosureOptions = {}): Promise<SellerDisclosureState> {
    validCommand(command.commandId);
    if (command.expectedVersion !== null && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion is invalid.");
    }
    const disclosure = validateSellerDisclosureInput(command.disclosure);
    const requestFingerprint = fingerprint(["SAVE", command.expectedVersion, disclosure]);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const seller = await ownerSeller(client, actor, options);
      await lockProviderDisclosure(client, actor.providerId);
      const previous = await previousResult(client, actor, command.commandId, requestFingerprint);
      if (previous) return previous;
      // 代理受領 (#725): the name is fixed while an agent-sales product takes bookings, whether or not the host has a seller profile.
      const existing = await client.query<DbRow>("SELECT seller_display_name,method FROM provider_seller_disclosures WHERE provider_id=$1 FOR SHARE", [actor.providerId]);
      const named = existing.rows[0]?.method === "NATIVE" ? String(existing.rows[0].seller_display_name) : null;
      if (named !== null && named !== disclosure.sellerDisplayName && await agentSalesOpen(client, actor.providerId)) {
        throw new StoreConflictError("The seller name cannot change while an agent-sales product takes bookings.");
      }
      if (seller.sellerDisplayName !== null) {
        await activePublicationsMatchSeller(client, actor, seller);
        if (disclosure.sellerDisplayName !== seller.sellerDisplayName) {
          throw new StoreConflictError("The public seller name does not match the provisioned legal seller.");
        }
      }
      const locked = await client.query<DbRow>("SELECT version FROM provider_seller_disclosures WHERE provider_id=$1 FOR UPDATE", [actor.providerId]);
      const currentVersion = locked.rows[0] ? Number(locked.rows[0].version) : null;
      if (currentVersion !== command.expectedVersion) throw new StoreConflictError("Seller disclosure version changed; read it again.");
      const result = await client.query<DbRow>(
        `INSERT INTO provider_seller_disclosures
           (provider_id,method,seller_kind,seller_display_name,representative_name,public_address,public_phone,public_email,
            external_url,consent_version,consented_at,consented_by_niho_user_id,withdrawn_at,withdrawn_by_niho_user_id,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11,NULL,NULL,1)
         ON CONFLICT (provider_id) DO UPDATE SET
           method=EXCLUDED.method,seller_kind=EXCLUDED.seller_kind,seller_display_name=EXCLUDED.seller_display_name,
           representative_name=EXCLUDED.representative_name,public_address=EXCLUDED.public_address,public_phone=EXCLUDED.public_phone,
           public_email=EXCLUDED.public_email,external_url=EXCLUDED.external_url,consent_version=EXCLUDED.consent_version,
           consented_at=EXCLUDED.consented_at,consented_by_niho_user_id=EXCLUDED.consented_by_niho_user_id,
           withdrawn_at=NULL,withdrawn_by_niho_user_id=NULL,version=provider_seller_disclosures.version+1,updated_at=clock_timestamp()
         RETURNING *`,
        [actor.providerId, disclosure.method, disclosure.sellerKind, disclosure.sellerDisplayName,
          disclosure.representativeName, disclosure.publicAddress, disclosure.publicPhone, disclosure.publicEmail,
          // NATIVE 保存は旧EXTERNAL行の external_url も必ず消す（0059 の method 別 CHECK 制約に合わせる）。
          null, disclosure.consentVersion, actor.nihoUserId],
      );
      const saved = stateFromRow(result.rows[0]!);
      await recordResult(client, actor, command.commandId, "SAVE", requestFingerprint, saved.version);
      return saved;
    });
  }

  async withdraw(actor: HostActor, command: WithdrawSellerDisclosureCommand, options: SellerDisclosureOptions = {}): Promise<SellerDisclosureState> {
    validCommand(command.commandId);
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) throw new StoreValidationError("expectedVersion is invalid.");
    const requestFingerprint = fingerprint(["WITHDRAW", command.expectedVersion]);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const seller = await ownerSeller(client, actor, options);
      await lockProviderDisclosure(client, actor.providerId);
      const previous = await previousResult(client, actor, command.commandId, requestFingerprint);
      if (previous) return previous;
      if (await agentSalesOpen(client, actor.providerId)) {
        throw new StoreConflictError("The seller disclosure cannot be withdrawn while an agent-sales product takes bookings.");
      }
      const result = await client.query<DbRow>(
        `UPDATE provider_seller_disclosures SET
           method='WITHDRAWN',representative_name=NULL,public_address=NULL,public_phone=NULL,public_email=NULL,external_url=NULL,
           withdrawn_at=clock_timestamp(),withdrawn_by_niho_user_id=$3,version=version+1,updated_at=clock_timestamp()
         WHERE provider_id=$1 AND version=$2 AND method <> 'WITHDRAWN'
         RETURNING *`,
        [actor.providerId, command.expectedVersion, actor.nihoUserId],
      );
      if (!result.rows[0]) throw new StoreConflictError("Seller disclosure version changed or is already withdrawn; read it again.");
      const withdrawn = stateFromRow(result.rows[0]);
      await recordResult(client, actor, command.commandId, "WITHDRAW", requestFingerprint, withdrawn.version);
      return withdrawn;
    });
  }

  /**
   * Public projection for one active publication. Current mapped OWNER, legal seller name,
   * and Connect recipient must still agree. Internal provider/account references never leave this method.
   */
  async getPublicBySlug(slug: string): Promise<PublicSellerDisclosure | null> {
    if (typeof slug !== "string" || slug.length < 1 || slug.length > 160) return null;
    const agent = await this.#publicAgentBySlug(slug);
    if (agent !== null) return agent;
    const result = await this.#pool.query<DbRow>(
      `SELECT disclosure.*
         FROM experience_product_publication_states state
         JOIN experience_product_publications publication
           ON publication.id=state.booking_publication_id
          AND publication.provider_id=state.provider_id AND publication.product_id=state.product_id
         ${CURRENT_SALES_PLAN}
         JOIN experience_host_seller_profiles profile ON profile.provider_id=publication.provider_id
         JOIN provider_seller_disclosures disclosure ON disclosure.provider_id=publication.provider_id
        WHERE publication.slug=$1
          AND state.self_stopped_at IS NULL AND state.operations_suspended_at IS NULL AND state.owner_resume_required=false
          AND disclosure.method='NATIVE'
          AND (plan.charge_mode IS NULL OR plan.charge_mode='CONNECT_DIRECT')
          AND disclosure.seller_display_name=COALESCE(plan.seller_display_name,publication.seller_display_name)
          AND disclosure.seller_display_name=profile.seller_display_name
          AND COALESCE(plan.seller_niho_account_ref,publication.seller_niho_account_ref)=profile.seller_niho_account_ref
          AND COALESCE(plan.stripe_account_ref,publication.stripe_connect_account_ref)=profile.stripe_connect_account_ref
          AND EXISTS (
            SELECT 1 FROM provider_memberships owner
             WHERE owner.provider_id=publication.provider_id
               AND owner.active=true AND owner.role='OWNER'
               AND ${sellerOwnerSql("owner", "profile")}
          )
        ORDER BY publication.published_at DESC,publication.id DESC LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    const sellerKind = String(row.seller_kind) as SellerKind;
    const sellerDisplayName = String(row.seller_display_name);
    return {
      method: "NATIVE", sellerKind, sellerDisplayName, representativeName: nullableText(row.representative_name),
      publicAddress: String(row.public_address), publicPhone: String(row.public_phone), publicEmail: String(row.public_email),
    };
  }

  /**
   * 代理受領 (#725): the host's own disclosure for a product sold with agent sales. It shows while the product's revision is the
   * agent plan, the OWNER's consent counts for that revision's seller, and the disclosure is the name the revision names; a withdrawn
   * consent or another name makes it disappear. Direct charge sellers never reach it (their products have no agent revision).
   */
  async #publicAgentBySlug(slug: string): Promise<PublicSellerDisclosure | null> {
    const result = await this.#pool.query<DbRow>(
      `SELECT disclosure.*
         FROM experience_product_publication_states state
         JOIN experience_product_publications publication
           ON publication.id=state.booking_publication_id
          AND publication.provider_id=state.provider_id AND publication.product_id=state.product_id
         ${CURRENT_SALES_PLAN}
         JOIN provider_seller_disclosures disclosure ON disclosure.provider_id=publication.provider_id
        WHERE publication.slug=$1
          AND state.self_stopped_at IS NULL AND state.operations_suspended_at IS NULL AND state.owner_resume_required=false
          AND disclosure.method='NATIVE'
          AND ${agentPlanSql("plan")}
          AND disclosure.seller_display_name=plan.seller_display_name
          AND ${countedAgentConsentSql("publication.provider_id", "plan")}
        ORDER BY publication.published_at DESC,publication.id DESC LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      method: "NATIVE", sellerKind: String(row.seller_kind) as SellerKind, sellerDisplayName: String(row.seller_display_name),
      representativeName: nullableText(row.representative_name),
      publicAddress: String(row.public_address), publicPhone: String(row.public_phone), publicEmail: String(row.public_email),
    };
  }
}
