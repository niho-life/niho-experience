import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import type { CalendarAccess, HostActor, MembershipRole } from "./types.ts";
import { assertStoreIdentifier } from "./validation.ts";

type Queryable = Pool | PoolClient;

function validate(actor: HostActor, productId: string): void {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  assertStoreIdentifier(productId, "productId");
}

/**
 * Product calendar access is deliberately separate from provider-wide membership.
 * In a mutation this runs after the provider inventory mutex and before command replay.
 */
export async function requireProductCalendarAccess(
  client: Queryable,
  actor: HostActor,
  productId: string,
  allowedMembershipRoles: readonly MembershipRole[],
): Promise<CalendarAccess> {
  validate(actor, productId);
  const member = await client.query<DbRow>(
    `SELECT role FROM provider_memberships
      WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role=ANY($3::text[]) FOR SHARE`,
    [actor.providerId, actor.nihoUserId, allowedMembershipRoles],
  );
  if (member.rows[0]) return { basis: "MEMBER", role: String(member.rows[0].role) as MembershipRole };
  const grant = await client.query<DbRow>(
    `SELECT version,assignment_label FROM product_operator_grants
      WHERE provider_id=$1 AND product_id=$3 AND niho_user_id=$2 AND active=true
        AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,
    [actor.providerId, actor.nihoUserId, productId],
  );
  if (!grant.rows[0]) throw new StoreAccessDeniedError();
  return { basis: "OPERATOR", version: Number(grant.rows[0].version), assignmentLabel: String(grant.rows[0].assignment_label) };
}

export async function listCalendarProductsForActor(client: Queryable, actor: HostActor): Promise<readonly { id: string; publicTitle: string; sellerDisplayName: string; access: CalendarAccess }[]> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  const result = await client.query<DbRow>(
    `SELECT p.id,p.public_title,p.seller_display_name,m.role,g.version AS grant_version,g.assignment_label
       FROM experience_products p
       LEFT JOIN provider_memberships m ON m.provider_id=p.provider_id AND m.niho_user_id=$2 AND m.active=true
       LEFT JOIN product_operator_grants g ON g.provider_id=p.provider_id AND g.product_id=p.id
         AND g.niho_user_id=$2 AND g.active=true AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      WHERE p.provider_id=$1 AND p.status<>'ARCHIVED' AND (m.provider_id IS NOT NULL OR g.provider_id IS NOT NULL)
      ORDER BY p.public_title COLLATE "C",p.id COLLATE "C" LIMIT 200`,
    [actor.providerId, actor.nihoUserId],
  );
  return result.rows.map((row) => ({
    id: String(row.id), publicTitle: String(row.public_title), sellerDisplayName: String(row.seller_display_name),
    access: row.role ? { basis: "MEMBER", role: String(row.role) as MembershipRole }
      : { basis: "OPERATOR", version: Number(row.grant_version), assignmentLabel: String(row.assignment_label) },
  }));
}
