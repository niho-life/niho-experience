import "server-only";
import { hostAccessFingerprint, type ProductOperatorAssignment } from "@niho-experience/experience-store";
import type { HostProvider } from "./providers";

/** The rendered provider list and enabled operator projection are also the revalidation boundary. */
export function renderedHostAccessFingerprint(providers: readonly HostProvider[], assignments: readonly ProductOperatorAssignment[]): string {
  return hostAccessFingerprint({
    memberships: providers.flatMap(({ id, memberRole }) => memberRole ? [{ providerId: id, role: memberRole }] : []),
    grants: assignments.map(({ providerId, productId, grantVersion, grantExpiresAtUtc }) => ({
      providerId, productId, version: grantVersion, ...(grantExpiresAtUtc ? { expiresAtUtc: grantExpiresAtUtc } : {}),
    })),
  });
}
