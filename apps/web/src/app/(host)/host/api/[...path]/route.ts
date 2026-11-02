import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { mutationFromSameOrigin, relayRequestHeaders, relayResponseHeaders, relayUpstreamPath } from "@/lib/host/relay";
import { hostNotFound, nihoApiFetch, noStoreJson, sessionSealer, siteOrigin } from "@/lib/host/server";
import { decodeSession, accessTokenUsable, SESSION_COOKIE } from "@/lib/host/session";

const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * `/host/api/<rest>` → `${NIHO}/api/<rest>` with the session's NIHO Web access token (#86).
 * Photos never pass through here: the browser posts them to a signed GCS URL.
 */
async function relay(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const { path } = await context.params;
  const method = request.method;
  const upstreamPath = relayUpstreamPath(method, path);
  if (!upstreamPath) return noStoreJson({ error: "not_found" }, 404);
  if (!mutationFromSameOrigin(method, request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);

  const session = decodeSession(sessionSealer(), request.cookies.get(SESSION_COOKIE)?.value, Date.now());
  if (!session) return noStoreJson({ error: "unauthenticated" }, 401);
  // NIHO is not called with an expiring token; the browser refreshes (one tab at a time) and retries once.
  if (!accessTokenUsable(session, Date.now())) return noStoreJson({ error: "session_refresh_required" }, 401);

  let body: ArrayBuffer | undefined;
  if (method !== "GET") {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return noStoreJson({ error: "payload_too_large" }, 413);
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_BYTES) return noStoreJson({ error: "payload_too_large" }, 413);
    body = buffer.byteLength > 0 ? buffer : undefined;
  }

  const url = new URL(upstreamPath, config.nihoWebOrigin);
  url.search = request.nextUrl.search;
  let upstream: Response;
  try {
    upstream = await nihoApiFetch(session)(url.href, {
      method,
      headers: relayRequestHeaders(request.headers, session.accessToken),
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return noStoreJson({ error: timedOut ? "niho_timeout" : "niho_unavailable" }, timedOut ? 504 : 502);
  }
  // NIHO refused the token (e.g. the connection was ended elsewhere): refresh decides whether to sign in again.
  if (upstream.status === 401) return noStoreJson({ error: "session_refresh_required" }, 401);
  // Redirects from the API are never followed or passed on.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) return noStoreJson({ error: "niho_unavailable" }, 502);
  const emptyBody = upstream.status === 204 || upstream.status === 304;
  return new NextResponse(emptyBody ? null : upstream.body, { status: upstream.status, headers: relayResponseHeaders(upstream.headers) });
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
