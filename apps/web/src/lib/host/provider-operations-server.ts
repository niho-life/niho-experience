import "server-only";
import { NextResponse } from "next/server";
import { createExperienceProviderOperationsClient, type ExperienceProviderOperationsFailure } from "@niho-experience/api-client/experience-provider-operations";
import { config } from "@/lib/config";
import { mutationFromSameOrigin } from "./relay";
import { clearSessionCookie, nihoApiFetch, readHostSession, siteOrigin } from "./server";
import { idTokenUsable } from "./session";

const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

export function providerOperationsEnabled(): boolean {
  return config.hostConsoleEnabled && (config.experienceProviderOperationsApiEnabled || config.experienceProviderOperationsPreviewEnabled);
}

export function providerOperationsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

export function providerOperationsEmpty(): NextResponse {
  return new NextResponse(null, { status: 204, headers: HEADERS });
}

export function providerOperationsMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, siteOrigin());
}

export async function readProviderOperationsJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > maxBytes) return { ok: false };
  let text: string;
  try { text = await request.text(); } catch { return { ok: false }; }
  if (!text || new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

export async function loadProviderOperationsClient() {
  if (!providerOperationsEnabled()) return { ok: false as const, response: providerOperationsJson({ error: "not_found" }, 404) };
  const session = await readHostSession();
  if (!session) return { ok: false as const, response: providerOperationsJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false as const, response: providerOperationsJson({ error: "session_refresh_required" }, 401) };
  try {
    return { ok: true as const, client: createExperienceProviderOperationsClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch: nihoApiFetch(session) }) };
  } catch { return { ok: false as const, response: providerOperationsJson({ error: "unavailable" }, 502) }; }
}

export function providerOperationsFailure(failure: ExperienceProviderOperationsFailure): NextResponse {
  if (failure.kind === "invalid_request") return providerOperationsJson({ error: "invalid_input" }, 400);
  if (failure.kind === "rejected") {
    const response = providerOperationsJson({ error: failure.status === 401 ? "session_ended" : "permission_ended" }, failure.status);
    if (failure.status === 401) clearSessionCookie(response);
    return response;
  }
  if (failure.kind === "not_found") return providerOperationsJson({ error: "permission_ended" }, 404);
  if (failure.kind === "conflict") return providerOperationsJson({ error: "conflict" }, 409);
  if (failure.kind === "network_error") return providerOperationsJson({ error: "upstream_unavailable" }, 502);
  return providerOperationsJson({ error: "unexpected_upstream_response" }, 502);
}
