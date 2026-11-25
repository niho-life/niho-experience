import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { OPERATOR_ASSERTION_HEADER, gateOperatorRequest, operatorApiPath } from "@/lib/admin/operator-cli";

const CANDIDATE_HOST = "(?:travel-candidate|experience(?:-stg)?-candidate)\\.niho\\.life";
const CANDIDATE_BOOKING_FORM = /^\/(?:ja\/|embed\/)?experiences\/[^/]+\/book(?:\/|$)/;
const candidateHost = new RegExp(`^${CANDIDATE_HOST}$`, "i");
const candidateHeaders = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "private, no-store" };

function candidateResponse(request: NextRequest): NextResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse(null, { status: 405, headers: { ...candidateHeaders, Allow: "GET, HEAD" } });
  }
  const { pathname } = request.nextUrl;
  if (pathname === "/robots.txt") {
    return new NextResponse(request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n", {
      headers: { ...candidateHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (pathname === "/indexnow-key.txt" || CANDIDATE_BOOKING_FORM.test(pathname)) {
    return new NextResponse(null, { status: 404, headers: candidateHeaders });
  }
  // Keep user-supplied CLI assertions out of handlers, including on candidate readbacks.
  const headers = new Headers(request.headers);
  headers.delete(OPERATOR_ASSERTION_HEADER);
  return NextResponse.next({ request: { headers }, headers: candidateHeaders });
}

/*
 * 運営の CLI (#576, docs/operator-cli.md): the one place that turns a Bearer Google ID token on /admin/api into the
 * admin's session for the route handlers. A value a client sends in OPERATOR_ASSERTION_HEADER is always dropped; only
 * the gate below sets it, sealed and good for a minute. Without the flag, or without a Bearer token, a request passes
 * unchanged (it is the cookie session's, as before).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (candidateHost.test(request.headers.get("host")?.split(":", 1)[0] ?? "")) return candidateResponse(request);

  const headers = new Headers(request.headers);
  headers.delete(OPERATOR_ASSERTION_HEADER);
  const bearer = /^bearer /i.test(request.headers.get("authorization") ?? "");
  if (!appConfig.operatorCliEnabled || !bearer || !operatorApiPath(request.nextUrl.pathname)) return NextResponse.next({ request: { headers } });
  const gate = await gateOperatorRequest(request);
  if (gate.kind === "refuse") return NextResponse.json({ error: gate.error }, { status: gate.status, headers: { "cache-control": "private, no-store" } });
  // The CLI's token and any cookie stay out of the route handlers: the assertion is the whole identity.
  headers.delete("authorization");
  headers.delete("cookie");
  if (gate.kind === "forward") headers.set(OPERATOR_ASSERTION_HEADER, gate.assertion);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/write/api/:path*",
    // Next.js analyzes matcher values statically.
    { source: "/:path*", has: [{ type: "host", value: "(?:travel-candidate|experience(?:-stg)?-candidate)\\.niho\\.life" }] },
  ],
};
