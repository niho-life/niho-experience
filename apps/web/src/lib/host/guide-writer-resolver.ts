import "server-only";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { readBoundedJson } from "@/lib/read-bounded-json";
import type { WriterIdentifier } from "@/lib/experience/guide-link-invitations";
import { nihoApiFetch } from "./server";
import type { HostSession } from "./session";

type ResolveResult =
  | { status: "ok"; writerNihoUserId: string }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterSeconds: number | null };

const USER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const serviceAuth = new GoogleAuth();

async function serviceIdentityToken(): Promise<string> {
  const client = await serviceAuth.getIdTokenClient(config.nihoWebOrigin);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Service identity unavailable");
  return authorization.slice(7);
}

/** The account ID stays between NIHO and Experience servers, never in the host response. */
export async function resolveGuideWriter(
  session: HostSession,
  identifier: WriterIdentifier,
  fetchImpl: typeof fetch = nihoApiFetch(session),
  getServiceToken: () => Promise<string> = serviceIdentityToken,
): Promise<ResolveResult> {
  let response: Response;
  try {
    const serviceToken = await getServiceToken();
    response = await fetchImpl(new URL("/api/experience-guide-writers/resolve", config.nihoWebOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.idToken}`,
        "x-niho-experience-service-id-token": serviceToken,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(identifier),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    // /auth/me checks host session liveness before this call. Resolver failures must not clear it.
    if (response.status === 404 && response.headers.get("x-niho-guide-writer-resolver") === "v1") {
      return { status: "not_found" };
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const retryAfterSeconds = retry && /^\d{1,5}$/.test(retry) ? Math.min(Number(retry), 3600) : null;
      return { status: "rate_limited", retryAfterSeconds };
    }
    return { status: "unavailable" };
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return { status: "unavailable" };
  }
  try {
    const body: unknown = await readBoundedJson(response, 1024, { fatalUtf8: true });
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: "unavailable" };
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).length !== 1 || typeof fields.writerNihoUserId !== "string" || !USER_ID.test(fields.writerNihoUserId)) {
      return { status: "unavailable" };
    }
    return { status: "ok", writerNihoUserId: fields.writerNihoUserId };
  } catch {
    return { status: "unavailable" };
  }
}
