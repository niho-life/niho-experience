import { isHostEmail } from "@niho-experience/experience-store";

/**
 * ホストへのメールの宛先 (#194, owner decision 2026-11-01): the NIHO account's verified address from the Firebase ID token
 * this server just got for it (signInWithCustomToken, NIHO app-connect). NIHO mints the custom token for the NIHO user ID
 * itself (its Firebase uid), so the token carries that account's `email` and `email_verified`, the same claims NIHO's own API
 * reads (`apps/api/src/middleware/auth.ts` in niho-app). The token came straight from Firebase to this server over TLS and
 * never from a browser, so its payload is read without checking the signature here; it is still only trusted for the user
 * the exchange named (`sub`), and only when `email_verified` is exactly true. Null otherwise: no address, an unverified one,
 * another user, or a token that cannot be read. Nothing here logs the token or the address.
 */
export function verifiedEmailFromIdToken(idToken: string, nihoUserId: string): string | null {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3 || !parts[1] || parts[1].length > 16_384) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const { sub, email, email_verified: verified } = claims as Record<string, unknown>;
  if (sub !== nihoUserId || verified !== true || typeof email !== "string") return null;
  const address = email.trim();
  return isHostEmail(address) ? address : null;
}
