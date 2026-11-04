/** Rules for the one legacy NIHO profile read still used by `/host/api/<rest>`. */
export const RELAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;
const MAX_SEGMENTS = 6;

/** Request headers the browser may pass to NIHO. Cookies, Authorization and hop-by-hop headers never pass. */
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-match", "if-none-match", "idempotency-key", "x-niho-page-updated-at"];
/** Response headers passed back. NIHO's cookies and encodings stay on the server. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-language", "etag", "last-modified", "retry-after", "x-niho-page-updated-at"];

/**
 * The only NIHO path exposed through this browser relay is the read-only
 * `GET /api/auth/me`. Provider, Connect, and booking operations use their own
 * server-side contracts and never pass through the browser relay.
 */
export function relayUpstreamPath(method: string, segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  if (!segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")) return null;
  return method === "GET" && segments.length === 2 && segments[0] === "auth" && segments[1] === "me"
    ? "/api/auth/me"
    : null;
}

/**
 * Changes are accepted only from this site's own pages: the browser must say the
 * request came from this origin and was same-origin (not merely same-site).
 */
export function mutationFromSameOrigin(method: string, headers: Headers, siteOrigin: string): boolean {
  if (SAFE_METHODS.has(method)) return true;
  return headers.get("origin") === siteOrigin && headers.get("sec-fetch-site") === "same-origin";
}

export function relayRequestHeaders(incoming: Headers, accessToken: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

export function relayResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  return headers;
}
