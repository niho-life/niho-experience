import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { lockProviderInventory } from "./inventory.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type {
  ProductOperatorAssignment,
  ProductOperatorGrantRecord,
  ProductOperatorInvitationRecord,
  ProductOperatorInvitationState,
} from "./types.ts";
import { assertNonEmptyText, assertStoreIdentifier } from "./validation.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProductOperatorAdminActor { readonly nihoUserId: string }

export interface CreateProductOperatorInvitationInput {
  readonly providerId: string;
  readonly productId: string;
  readonly assignmentLabel: string;
  readonly expiresInDays?: number;
}

export interface CreatedProductOperatorInvitation {
  readonly invitation: ProductOperatorInvitationRecord;
  /** Returned once only. A repeated command deliberately omits it. */
  readonly token?: string;
  readonly repeated: boolean;
}

export interface PreparedProductOperatorInvitation {
  readonly invitationId: string;
  readonly expiresAtUtc: string;
}

export interface ProductOperatorAdminSnapshot {
  readonly products: readonly { providerId: string; productId: string; productTitle: string; sellerDisplayName: string }[];
  readonly invitations: readonly ProductOperatorInvitationRecord[];
  readonly grants: readonly ProductOperatorGrantRecord[];
}

function uuid(value: string, path: string): void {
  if (!UUID_V4.test(value)) throw new StoreValidationError(`${path} must be a UUID v4.`);
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function secureTokenMatch(stored: unknown, token: string): boolean {
  if (!validToken(token)) return false;
  const left = Buffer.isBuffer(stored) ? stored : stored instanceof Uint8Array ? Buffer.from(stored) : Buffer.alloc(0);
  const right = tokenDigest(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function invitation(row: DbRow): ProductOperatorInvitationRecord {
  return {
    id: String(row.id), providerId: String(row.provider_id), productId: String(row.product_id),
    productTitle: String(row.public_title), sellerDisplayName: String(row.seller_display_name),
    assignmentLabel: String(row.assignment_label), state: String(row.state) as ProductOperatorInvitationState,
    expiresAtUtc: isoValue(row, "expires_at"),
    ...(row.accepted_niho_user_id ? { acceptedNihoUserId: String(row.accepted_niho_user_id) } : {}),
    ...(row.accepted_at ? { acceptedAtUtc: isoValue(row, "accepted_at") } : {}),
    ...(row.revoked_at ? { revokedAtUtc: isoValue(row, "revoked_at") } : {}),
    revision: Number(row.revision), createdAtUtc: isoValue(row, "created_at"),
  };
}

function grant(row: DbRow): ProductOperatorGrantRecord {
  return {
    providerId: String(row.provider_id), productId: String(row.product_id), productTitle: String(row.public_title),
    sellerDisplayName: String(row.seller_display_name), nihoUserId: String(row.niho_user_id),
    assignmentLabel: String(row.assignment_label), active: row.active === true,
    ...(row.expires_at ? { expiresAtUtc: isoValue(row, "expires_at") } : {}), version: Number(row.version),
    grantedAtUtc: isoValue(row, "granted_at"), ...(row.revoked_at ? { revokedAtUtc: isoValue(row, "revoked_at") } : {}),
  };
}

function invitationCommandResult(result: Record<string, unknown>): ProductOperatorInvitationRecord {
  const value = result.invitation;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { id?: unknown }).id !== "string") {
    throw new StoreConflictError("The invitation command result is invalid.");
  }
  return value as ProductOperatorInvitationRecord;
}

function grantCommandResult(result: Record<string, unknown>): ProductOperatorGrantRecord {
  const value = result.grant;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { providerId?: unknown }).providerId !== "string"
    || typeof (value as { productId?: unknown }).productId !== "string"
    || typeof (value as { nihoUserId?: unknown }).nihoUserId !== "string") {
    throw new StoreConflictError("The grant command result is invalid.");
  }
  return value as ProductOperatorGrantRecord;
}

async function previousCommand(client: PoolClient, actor: ProductOperatorAdminActor, commandId: string, action: string, requestFingerprint: string): Promise<Record<string, unknown> | null> {
  uuid(commandId, "commandId");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 41))", [`product-operator-command:${commandId}`]);
  const result = await client.query<DbRow>(
    "SELECT actor_niho_user_id,action,request_fingerprint,result FROM product_operator_commands WHERE command_id=$1::uuid",
    [commandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.actor_niho_user_id !== actor.nihoUserId || row.action !== action || row.request_fingerprint !== requestFingerprint) {
    throw new StoreConflictError("The operator command ID was already used with different input.");
  }
  if (!row.result || typeof row.result !== "object" || Array.isArray(row.result)) throw new StoreConflictError("The operator command result is invalid.");
  return row.result as Record<string, unknown>;
}

async function completeCommand(client: PoolClient, actor: ProductOperatorAdminActor, commandId: string, action: string, requestFingerprint: string, result: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO product_operator_commands (command_id,actor_niho_user_id,action,request_fingerprint,result)
     VALUES ($1::uuid,$2,$3,$4,$5::jsonb)`,
    [commandId, actor.nihoUserId, action, requestFingerprint, JSON.stringify(result)],
  );
}

async function audit(client: PoolClient, input: { providerId: string; productId: string; invitationId?: string; grantNihoUserId?: string; actorNihoUserId: string; action: string; metadata?: Record<string, unknown> }): Promise<void> {
  await client.query(
    `INSERT INTO product_operator_audit_events
       (id,provider_id,product_id,invitation_id,grant_niho_user_id,actor_niho_user_id,action,metadata)
     VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb)`,
    [randomUUID(), input.providerId, input.productId, input.invitationId ?? null, input.grantNihoUserId ?? null,
      input.actorNihoUserId, input.action, JSON.stringify(input.metadata ?? {})],
  );
}

/** Resolve immutable invitation scope while taking the provider inventory mutex as the transaction's first statement. */
async function lockInvitationProviderInventory(client: PoolClient, invitationId: string): Promise<{ providerId: string; productId: string }> {
  const result = await client.query<DbRow>(
    `SELECT i.provider_id,i.product_id,
            pg_advisory_xact_lock(hashtextextended('provider-inventory:' || i.provider_id,31)) AS inventory_locked
       FROM product_operator_invitations i WHERE i.id=$1::uuid`,
    [invitationId],
  );
  const row = result.rows[0];
  if (!row) throw new StoreNotFoundError("operator invitation");
  return { providerId: String(row.provider_id), productId: String(row.product_id) };
}

const INVITATION_SELECT = `SELECT i.*,p.public_title,p.seller_display_name
  FROM product_operator_invitations i
  JOIN experience_products p ON p.provider_id=i.provider_id AND p.id=i.product_id`;
const GRANT_SELECT = `SELECT g.*,p.public_title,p.seller_display_name
  FROM product_operator_grants g
  JOIN experience_products p ON p.provider_id=g.provider_id AND p.id=g.product_id`;

export class ProductOperatorRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async listAssignments(nihoUserId: string): Promise<readonly ProductOperatorAssignment[]> {
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT g.provider_id,g.product_id,g.assignment_label,g.version,g.expires_at,p.public_title,p.seller_display_name
         FROM product_operator_grants g JOIN experience_products p ON p.provider_id=g.provider_id AND p.id=g.product_id
        WHERE g.niho_user_id=$1 AND g.active=true AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
          AND p.status<>'ARCHIVED'
        ORDER BY p.seller_display_name COLLATE "C",p.public_title COLLATE "C" LIMIT 200`,
      [nihoUserId],
    );
    return result.rows.map((row) => ({
      providerId: String(row.provider_id), productId: String(row.product_id), productTitle: String(row.public_title),
      sellerDisplayName: String(row.seller_display_name), assignmentLabel: String(row.assignment_label),
      grantVersion: Number(row.version), ...(row.expires_at ? { grantExpiresAtUtc: isoValue(row, "expires_at") } : {}),
    }));
  }

  async adminSnapshot(search = ""): Promise<ProductOperatorAdminSnapshot> {
    const query = search.replace(/\s+/g, " ").trim().slice(0, 100);
    const products = await this.#pool.query<DbRow>(
      `SELECT provider_id,id,public_title,seller_display_name FROM experience_products
        WHERE status<>'ARCHIVED' AND ($1='' OR public_title ILIKE '%'||$1||'%' OR seller_display_name ILIKE '%'||$1||'%')
        ORDER BY seller_display_name COLLATE "C",public_title COLLATE "C",id COLLATE "C" LIMIT 200`, [query],
    );
    const invitations = await this.#pool.query<DbRow>(`${INVITATION_SELECT} ORDER BY i.created_at DESC LIMIT 200`);
    const grants = await this.#pool.query<DbRow>(`${GRANT_SELECT} ORDER BY g.updated_at DESC LIMIT 200`);
    return {
      products: products.rows.map((row) => ({ providerId: String(row.provider_id), productId: String(row.id), productTitle: String(row.public_title), sellerDisplayName: String(row.seller_display_name) })),
      invitations: invitations.rows.map(invitation), grants: grants.rows.map(grant),
    };
  }

  async createInvitation(actor: ProductOperatorAdminActor, input: CreateProductOperatorInvitationInput, commandId: string): Promise<CreatedProductOperatorInvitation> {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(input.providerId, "providerId");
    assertStoreIdentifier(input.productId, "productId");
    assertNonEmptyText(input.assignmentLabel, "assignmentLabel", 100);
    const assignmentLabel = input.assignmentLabel.replace(/\s+/g, " ").trim();
    const expiresInDays = input.expiresInDays ?? 7;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 7) throw new StoreValidationError("expiresInDays must be from 1 to 7.");
    uuid(commandId, "commandId");
    const requestFingerprint = fingerprint({ input: { ...input, assignmentLabel, expiresInDays } });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, input.providerId);
      const previous = await previousCommand(client, actor, commandId, "INVITATION_CREATE", requestFingerprint);
      if (previous) {
        return { invitation: invitationCommandResult(previous), repeated: true };
      }
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE", [input.providerId, input.productId]);
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const expiresAtUtc = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
      const saved = await client.query<DbRow>(
        `INSERT INTO product_operator_invitations
           (id,provider_id,product_id,token_hash,assignment_label,invited_by_niho_user_id,expires_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, input.providerId, input.productId, tokenDigest(token), assignmentLabel, actor.nihoUserId, expiresAtUtc],
      );
      const row = { ...saved.rows[0]!, public_title: "", seller_display_name: "" };
      const hydrated = await client.query<DbRow>(`${INVITATION_SELECT} WHERE i.id=$1::uuid`, [id]);
      const record = invitation(hydrated.rows[0] ?? row);
      await completeCommand(client, actor, commandId, "INVITATION_CREATE", requestFingerprint, { invitation: record });
      await audit(client, { providerId: input.providerId, productId: input.productId, invitationId: id, actorNihoUserId: actor.nihoUserId, action: "INVITATION_CREATED", metadata: { expiresAtUtc } });
      return { invitation: record, token, repeated: false };
    });
  }

  async prepare(invitationId: string, token: string): Promise<PreparedProductOperatorInvitation> {
    uuid(invitationId, "invitationId");
    const result = await this.#pool.query<DbRow>(
      `SELECT id,token_hash,expires_at,state,clock_timestamp() AS db_now
         FROM product_operator_invitations WHERE id=$1::uuid`, [invitationId],
    );
    const row = result.rows[0];
    if (!row || row.state === "REVOKED" || isoValue(row, "expires_at") <= isoValue(row, "db_now") || !secureTokenMatch(row.token_hash, token)) {
      throw new StoreAccessDeniedError();
    }
    return { invitationId, expiresAtUtc: isoValue(row, "expires_at") };
  }

  async inspectForIdentity(invitationId: string, token: string, nihoUserId: string): Promise<ProductOperatorInvitationRecord> {
    uuid(invitationId, "invitationId");
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    const result = await this.#pool.query<DbRow>(
      `SELECT i.*,p.public_title,p.seller_display_name,clock_timestamp() AS db_now
         FROM product_operator_invitations i
         JOIN experience_products p ON p.provider_id=i.provider_id AND p.id=i.product_id
        WHERE i.id=$1::uuid`, [invitationId],
    );
    const row = result.rows[0];
    if (!row || !secureTokenMatch(row.token_hash, token) || row.state === "REVOKED" || isoValue(row, "expires_at") <= isoValue(row, "db_now")
      || (row.state === "ACCEPTED" && row.accepted_niho_user_id !== nihoUserId)) throw new StoreAccessDeniedError();
    return invitation(row);
  }

  async accept(invitationId: string, token: string, nihoUserId: string): Promise<ProductOperatorGrantRecord> {
    uuid(invitationId, "invitationId");
    assertStoreIdentifier(nihoUserId, "nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      let scope: { providerId: string; productId: string };
      try { scope = await lockInvitationProviderInventory(client, invitationId); }
      catch (error) { if (error instanceof StoreNotFoundError) throw new StoreAccessDeniedError(); throw error; }
      const { providerId, productId } = scope;
      const locked = await client.query<DbRow>(
        "SELECT *,clock_timestamp() AS db_now FROM product_operator_invitations WHERE id=$1::uuid FOR UPDATE", [invitationId],
      );
      const row = locked.rows[0];
      if (!row || !secureTokenMatch(row.token_hash, token) || row.state === "REVOKED") throw new StoreAccessDeniedError();
      if (row.state === "ACCEPTED" && row.accepted_niho_user_id !== nihoUserId) throw new StoreConflictError("This invitation has already been accepted.");
      if (row.state === "PENDING" && isoValue(row, "expires_at") <= isoValue(row, "db_now")) throw new StoreAccessDeniedError();
      if (row.state === "PENDING") {
        await client.query(
          `UPDATE product_operator_invitations SET state='ACCEPTED',accepted_niho_user_id=$2,accepted_at=clock_timestamp(),
             revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid`, [invitationId, nihoUserId],
        );
        await client.query(
          `INSERT INTO product_operator_grants
             (provider_id,product_id,niho_user_id,invitation_id,assignment_label)
           VALUES ($1,$2,$3,$4::uuid,$5)
           ON CONFLICT (provider_id,product_id,niho_user_id) DO UPDATE SET
             invitation_id=EXCLUDED.invitation_id,assignment_label=EXCLUDED.assignment_label,active=true,expires_at=NULL,
             version=product_operator_grants.version+1,revoked_at=NULL,updated_at=clock_timestamp()`,
          [providerId, productId, nihoUserId, invitationId, row.assignment_label],
        );
        await audit(client, { providerId, productId, invitationId, grantNihoUserId: nihoUserId, actorNihoUserId: nihoUserId, action: "INVITATION_ACCEPTED" });
      }
      const result = await client.query<DbRow>(`${GRANT_SELECT} WHERE g.provider_id=$1 AND g.product_id=$2 AND g.niho_user_id=$3`, [providerId, productId, nihoUserId]);
      const saved = result.rows[0];
      if (!saved || saved.active !== true) throw new StoreAccessDeniedError();
      return grant(saved);
    });
  }

  async revokeInvitation(actor: ProductOperatorAdminActor, invitationId: string, expectedRevision: number, commandId: string): Promise<ProductOperatorInvitationRecord> {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId"); uuid(invitationId, "invitationId"); uuid(commandId, "commandId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new StoreValidationError("expectedRevision must be positive.");
    const requestFingerprint = fingerprint({ invitationId, expectedRevision });
    return withTransaction(this.#pool, async (client) => {
      const { providerId, productId } = await lockInvitationProviderInventory(client, invitationId);
      const previous = await previousCommand(client, actor, commandId, "INVITATION_REVOKE", requestFingerprint);
      if (previous) return invitationCommandResult(previous);
      const updated = await client.query(
        `UPDATE product_operator_invitations SET state='REVOKED',revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1::uuid AND revision=$2 AND state<>'REVOKED'`, [invitationId, expectedRevision],
      );
      if (!updated.rowCount) throw new StoreConflictError("Invitation revision mismatch or invitation already revoked.");
      const result = await client.query<DbRow>(`${INVITATION_SELECT} WHERE i.id=$1::uuid`, [invitationId]);
      const record = invitation(result.rows[0]!);
      await completeCommand(client, actor, commandId, "INVITATION_REVOKE", requestFingerprint, { invitation: record });
      await audit(client, { providerId, productId, invitationId, actorNihoUserId: actor.nihoUserId, action: "INVITATION_REVOKED" });
      return record;
    });
  }

  async revokeGrant(actor: ProductOperatorAdminActor, providerId: string, productId: string, nihoUserId: string, expectedVersion: number, commandId: string): Promise<ProductOperatorGrantRecord> {
    assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId"); assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId"); assertStoreIdentifier(nihoUserId, "nihoUserId"); uuid(commandId, "commandId");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new StoreValidationError("expectedVersion must be positive.");
    const requestFingerprint = fingerprint({ providerId, productId, nihoUserId, expectedVersion });
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const previous = await previousCommand(client, actor, commandId, "GRANT_REVOKE", requestFingerprint);
      if (previous) return grantCommandResult(previous);
      const updated = await client.query(
        `UPDATE product_operator_grants SET active=false,revoked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND niho_user_id=$3 AND version=$4 AND active=true`,
        [providerId, productId, nihoUserId, expectedVersion],
      );
      if (!updated.rowCount) throw new StoreConflictError("Grant version mismatch or grant already revoked.");
      const result = await client.query<DbRow>(`${GRANT_SELECT} WHERE g.provider_id=$1 AND g.product_id=$2 AND g.niho_user_id=$3`, [providerId, productId, nihoUserId]);
      if (!result.rows[0]) throw new StoreNotFoundError("operator grant");
      const record = grant(result.rows[0]);
      await completeCommand(client, actor, commandId, "GRANT_REVOKE", requestFingerprint, { grant: record });
      await audit(client, { providerId, productId, grantNihoUserId: nihoUserId, actorNihoUserId: actor.nihoUserId, action: "GRANT_REVOKED" });
      return record;
    });
  }
}
