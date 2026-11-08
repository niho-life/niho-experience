import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import { isHostAccountId, normalizeHostEmail } from "./host-accounts.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

export const HOST_TEAM_CONTRACT_VERSION = 1 as const;
export const HOST_TEAM_RESOLVE_LIMIT = 12 as const;
export type HostTeamMemberRole = "OWNER" | "COHOST" | "EDITOR" | "VIEWER";
export type HostTeamOperation = "ADD_COHOST" | "REMOVE_COHOST";

export interface HostTeamActor {
  readonly providerId: string;
  readonly hostAccountId: string;
}

export interface HostTeamMember {
  readonly hostAccountId: string;
  readonly role: HostTeamMemberRole;
  readonly label: string;
}

export interface HostTeamSnapshot {
  readonly contractVersion: typeof HOST_TEAM_CONTRACT_VERSION;
  readonly teamRevision: number;
  readonly members: readonly HostTeamMember[];
}

export interface HostTeamCandidate {
  readonly hostAccountId: string;
  readonly label: string;
}

export interface HostTeamCommandReceipt {
  readonly commandId: string;
  readonly operation: HostTeamOperation;
  readonly fingerprint: string;
  readonly version: number;
  readonly repeated: boolean;
}

export interface HostTeamMutationResult extends HostTeamSnapshot {
  readonly receipt: HostTeamCommandReceipt;
}

export interface HostAccessProjection {
  readonly memberships: readonly { readonly providerId: string; readonly role: HostTeamMemberRole }[];
  readonly grants: readonly { readonly providerId: string; readonly productId: string; readonly version: number; readonly expiresAtUtc?: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEAM_LOCK_SEED = 83;

function actorOf(input: HostTeamActor): HostTeamActor {
  assertStoreIdentifier(input?.providerId, "providerId");
  if (!isHostAccountId(input?.hostAccountId)) throw new StoreValidationError("hostAccountId must be an Experience host account ID.");
  return input;
}

function accountId(value: unknown): string {
  if (!isHostAccountId(value)) throw new StoreValidationError("targetHostAccountId must be an Experience host account ID.");
  return value;
}

function commandIdOf(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("commandId must be a UUID.");
  return value.toLowerCase();
}

function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new StoreValidationError("expectedRevision must be a non-negative safe integer.");
  return value;
}

function safeVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new StoreError("Database returned an invalid team version.");
  return version;
}

/** Canonical fingerprint of exactly the role/grant projection used to render private navigation. */
export function hostAccessFingerprint(projection: HostAccessProjection): string {
  const memberships = [...projection.memberships]
    .map(({ providerId, role }) => [providerId, role] as const)
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  const grants = [...projection.grants]
    .map(({ providerId, productId, version, expiresAtUtc }) => [providerId, productId, version, expiresAtUtc ?? null] as const)
    .sort(([leftProvider, leftProduct], [rightProvider, rightProduct]) => leftProvider.localeCompare(rightProvider, "en") || leftProduct.localeCompare(rightProduct, "en"));
  return createHash("sha256").update(JSON.stringify([HOST_TEAM_CONTRACT_VERSION, memberships, grants]), "utf8").digest("hex");
}

function memberLabel(email: unknown): string {
  if (typeof email !== "string" || email.trim() === "") throw new StoreError("Database returned an invalid host account email.");
  return email;
}

async function requireCurrentOwner(client: PoolClient, actor: HostTeamActor, lock: "FOR SHARE" | "FOR UPDATE" = "FOR SHARE"): Promise<void> {
  const result = await client.query<DbRow>(
    `SELECT 1 FROM provider_memberships m
       JOIN host_accounts a ON a.id=m.niho_user_id AND a.status='ACTIVE'
      WHERE m.provider_id=$1 AND m.niho_user_id=$2 AND m.active AND m.role='OWNER' ${lock}`,
    [actor.providerId, actor.hostAccountId],
  );
  if (!result.rows[0]) throw new StoreAccessDeniedError();
}

async function lockTeam(client: PoolClient, providerId: string): Promise<number> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`experience-provider-team:${providerId}`, TEAM_LOCK_SEED]);
  await client.query(
    `INSERT INTO provider_team_revisions (provider_id,version,updated_at) VALUES ($1,0,clock_timestamp())
     ON CONFLICT (provider_id) DO NOTHING`,
    [providerId],
  );
  const locked = await client.query<DbRow>("SELECT version FROM provider_team_revisions WHERE provider_id=$1 FOR UPDATE", [providerId]);
  if (!locked.rows[0]) throw new StoreError("Provider team revision was not created.");
  return safeVersion(locked.rows[0].version);
}

async function members(client: PoolClient, providerId: string): Promise<readonly HostTeamMember[]> {
  const found = await client.query<DbRow>(
    `SELECT m.niho_user_id,m.role,a.email FROM provider_memberships m
       JOIN host_accounts a ON a.id=m.niho_user_id AND a.status='ACTIVE'
      WHERE m.provider_id=$1 AND m.active AND m.niho_user_id ~ '^hst_[0-9a-f]{32}$'
        AND m.role IN ('OWNER','COHOST','EDITOR','VIEWER')
      ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'COHOST' THEN 1 WHEN 'EDITOR' THEN 2 ELSE 3 END,m.niho_user_id COLLATE "C"`,
    [providerId],
  );
  return found.rows.map((row) => {
    const id = String(row.niho_user_id);
    const role = String(row.role);
    if (!isHostAccountId(id) || !["OWNER", "COHOST", "EDITOR", "VIEWER"].includes(role)) throw new StoreError("Database returned an invalid team member.");
    return { hostAccountId: id, role: role as HostTeamMemberRole, label: memberLabel(row.email) };
  });
}

function fingerprint(actor: HostTeamActor, operation: HostTeamOperation, target: string, expectedRevision: number): string {
  return createHash("sha256").update(JSON.stringify([
    HOST_TEAM_CONTRACT_VERSION, actor.providerId, actor.hostAccountId, operation, target, expectedRevision,
  ]), "utf8").digest("hex");
}

/** Experience-native provider teams. Every method rechecks the current DB membership and ACTIVE account. */
export class HostTeamRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async list(input: HostTeamActor): Promise<HostTeamSnapshot> {
    const actor = actorOf(input);
    return withTransaction(this.#pool, async (client) => {
      await requireCurrentOwner(client, actor);
      const version = await lockTeam(client, actor.providerId);
      return { contractVersion: HOST_TEAM_CONTRACT_VERSION, teamRevision: version, members: await members(client, actor.providerId) };
    });
  }

  async resolve(input: HostTeamActor & { readonly email: string }): Promise<{ readonly contractVersion: 1; readonly teamRevision: number; readonly candidate: HostTeamCandidate | null }> {
    const actor = actorOf(input);
    const emailKey = normalizeHostEmail(input?.email);
    return withTransaction(this.#pool, async (client) => {
      await requireCurrentOwner(client, actor, "FOR UPDATE");
      const version = await lockTeam(client, actor.providerId);
      const bucket = await client.query<DbRow>(
        `INSERT INTO provider_team_resolve_buckets (provider_id,owner_host_account_id,window_started_at,attempts)
         VALUES ($1,$2,date_trunc('hour',clock_timestamp()),1)
         ON CONFLICT (provider_id,owner_host_account_id,window_started_at)
         DO UPDATE SET attempts=provider_team_resolve_buckets.attempts+1
           WHERE provider_team_resolve_buckets.attempts < $3
         RETURNING attempts,extract(epoch FROM (window_started_at+interval '1 hour'-clock_timestamp()))::integer AS retry_after`,
        [actor.providerId, actor.hostAccountId, HOST_TEAM_RESOLVE_LIMIT],
      );
      if (!bucket.rows[0]) {
        const current = await client.query<DbRow>(
          `SELECT GREATEST(1,extract(epoch FROM (window_started_at+interval '1 hour'-clock_timestamp()))::integer) AS retry_after
             FROM provider_team_resolve_buckets
            WHERE provider_id=$1 AND owner_host_account_id=$2 AND window_started_at=date_trunc('hour',clock_timestamp())`,
          [actor.providerId, actor.hostAccountId],
        );
        throw new StoreRateLimitedError(Math.max(1, Number(current.rows[0]?.retry_after ?? 60)));
      }
      const found = await client.query<DbRow>("SELECT id,email FROM host_accounts WHERE email_key=$1 AND status='ACTIVE'", [emailKey]);
      const id = found.rows[0]?.id;
      const candidate = isHostAccountId(id) ? { hostAccountId: id, label: memberLabel(found.rows[0]?.email) } : null;
      return { contractVersion: HOST_TEAM_CONTRACT_VERSION, teamRevision: version, candidate };
    });
  }

  async addCohost(input: HostTeamActor & { readonly targetHostAccountId: string; readonly commandId: string; readonly expectedRevision: number }): Promise<HostTeamMutationResult> {
    return this.#mutate("ADD_COHOST", input);
  }

  async removeCohost(input: HostTeamActor & { readonly targetHostAccountId: string; readonly commandId: string; readonly expectedRevision: number }): Promise<HostTeamMutationResult> {
    return this.#mutate("REMOVE_COHOST", input);
  }

  async #mutate(operation: HostTeamOperation, input: HostTeamActor & { readonly targetHostAccountId: string; readonly commandId: string; readonly expectedRevision: number }): Promise<HostTeamMutationResult> {
    const actor = actorOf(input);
    const target = accountId(input?.targetHostAccountId);
    const commandId = commandIdOf(input?.commandId);
    const expected = revisionOf(input?.expectedRevision);
    const requestFingerprint = fingerprint(actor, operation, target, expected);
    return withTransaction(this.#pool, async (client) => {
      // Revocation wins over every replay: actor validation is intentionally before receipt lookup.
      await requireCurrentOwner(client, actor, "FOR UPDATE");
      const current = await lockTeam(client, actor.providerId);
      const old = await client.query<DbRow>(
        "SELECT actor_host_account_id,operation,request_fingerprint,result_version FROM provider_team_commands WHERE provider_id=$1 AND command_id=$2",
        [actor.providerId, commandId],
      );
      if (old.rows[0]) {
        const resultVersion = safeVersion(old.rows[0].result_version);
        if (old.rows[0].actor_host_account_id !== actor.hostAccountId || old.rows[0].operation !== operation || old.rows[0].request_fingerprint !== requestFingerprint) throw new StoreConflictError("commandId was already used for another team command.");
        if (current !== resultVersion) throw new StoreConflictError("The team changed after this command; reload before continuing.");
        return {
          contractVersion: HOST_TEAM_CONTRACT_VERSION,
          teamRevision: current,
          members: await members(client, actor.providerId),
          receipt: { commandId, operation, fingerprint: requestFingerprint, version: resultVersion, repeated: true },
        };
      }
      if (current !== expected) throw new StoreConflictError("The team changed; reload before continuing.");

      const targetAccount = await client.query<DbRow>("SELECT status FROM host_accounts WHERE id=$1 FOR UPDATE", [target]);
      if (!targetAccount.rows[0] || targetAccount.rows[0].status !== "ACTIVE") throw new StoreNotFoundError("active host account");
      const targetMembership = await client.query<DbRow>("SELECT role,active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 FOR UPDATE", [actor.providerId, target]);
      const existingRole = targetMembership.rows[0]?.role;
      const active = targetMembership.rows[0]?.active === true;
      if (operation === "ADD_COHOST") {
        if (existingRole && (existingRole !== "COHOST" || active)) throw new StoreConflictError("The account already has a provider role.");
        if (existingRole === "COHOST") {
          await client.query("UPDATE provider_memberships SET active=true,updated_at=clock_timestamp() WHERE provider_id=$1 AND niho_user_id=$2", [actor.providerId, target]);
        } else {
          await client.query(
            `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active,created_at,updated_at)
             VALUES ($1,$2,'COHOST',true,clock_timestamp(),clock_timestamp())`,
            [actor.providerId, target],
          );
        }
      } else {
        if (existingRole !== "COHOST" || !active) throw new StoreConflictError("Only an active COHOST may be removed.");
        await client.query("UPDATE provider_memberships SET active=false,updated_at=clock_timestamp() WHERE provider_id=$1 AND niho_user_id=$2 AND role='COHOST'", [actor.providerId, target]);
      }

      const version = current + 1;
      await client.query("UPDATE provider_team_revisions SET version=$2,updated_at=clock_timestamp() WHERE provider_id=$1", [actor.providerId, version]);
      await client.query(
        `INSERT INTO provider_team_commands (provider_id,command_id,actor_host_account_id,operation,request_fingerprint,result_version,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
        [actor.providerId, commandId, actor.hostAccountId, operation, requestFingerprint, version],
      );
      return {
        contractVersion: HOST_TEAM_CONTRACT_VERSION,
        teamRevision: version,
        members: await members(client, actor.providerId),
        receipt: { commandId, operation, fingerprint: requestFingerprint, version, repeated: false },
      };
    });
  }

}
