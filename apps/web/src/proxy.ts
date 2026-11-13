import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { OPERATOR_ASSERTION_HEADER, gateOperatorRequest, operatorApiPath } from "@/lib/admin/operator-cli";

/*
 * 運営の CLI (#576, docs/operator-cli.md): the one place that turns a Bearer Google ID token on /admin/api into the
 * admin's session for the route handlers. A value a client sends in OPERATOR_ASSERTION_HEADER is always dropped; only
 * the gate below sets it, sealed and good for a minute. Without the flag, or without a Bearer token, a request passes
 * unchanged (it is the cookie session's, as before).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
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

export const config = { matcher: ["/admin/:path*"] };
