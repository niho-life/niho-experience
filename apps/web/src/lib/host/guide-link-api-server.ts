import "server-only";
import { GoogleAuth } from "google-auth-library";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { clearSessionCookie, nihoApiFetch, noStoreJson, readHostSession } from "./server";
import { accessTokenUsable, type NihoHostSession } from "./session";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["PENDING", "ACCEPTED", "DECLINED", "REVOKED", "EXPIRED"]);
const auth = new GoogleAuth();

export interface HostArticleLink {
  readonly id: string; readonly state: string; readonly providerName: string; readonly inviterName: string;
  readonly writerName: string; readonly writerLabel: string; readonly expiresAt: string; readonly acceptedAt: string | null; readonly createdAt: string;
}

function link(value: unknown): HostArticleLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid NIHO response");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "acceptedAt,createdAt,expiresAt,id,inviterName,providerName,state,writerLabel,writerName"
    || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.state !== "string" || !STATES.has(item.state)
    || [item.providerName, item.inviterName, item.writerName, item.writerLabel].some((field) => typeof field !== "string" || !field || field.length > 300)
    || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)) || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || (item.acceptedAt !== null && (typeof item.acceptedAt !== "string" || !Number.isFinite(Date.parse(item.acceptedAt))))) throw new Error("Invalid NIHO response");
  return item as unknown as HostArticleLink;
}

async function serviceToken(): Promise<string> {
  const client = await auth.getIdTokenClient(config.nihoArticleLinksAudience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Service identity unavailable");
  return authorization.slice(7);
}

export class HostArticleLinkClient {
  constructor(private readonly session: NihoHostSession, private readonly fetchImpl: typeof fetch = nihoApiFetch(session), private readonly token = serviceToken) {}
  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const identity = await this.token();
    const response = await this.fetchImpl(new URL(path, config.nihoArticleAuthorityOrigin), {
      ...init, headers: { authorization: `Bearer ${this.session.accessToken}`, "x-niho-experience-service-id-token": identity, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      const error = new Error("NIHO article links unavailable") as Error & { status?: number }; error.status = response.status; throw error;
    }
    return readBoundedJson(response, 64 * 1024, { fatalUtf8: true });
  }
  async list(providerId: string): Promise<readonly HostArticleLink[]> {
    if (!PROVIDER_ID.test(providerId)) throw new Error("Invalid provider");
    const value = await this.call(`/api/experience-guide-links/providers/${encodeURIComponent(providerId)}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid NIHO response");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || !Array.isArray(body.items)) throw new Error("Invalid NIHO response");
    return body.items.map(link);
  }
  invite(providerId: string, email: string): Promise<HostArticleLink> {
    if (!PROVIDER_ID.test(providerId) || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Invalid invitation");
    return this.call(`/api/experience-guide-links/providers/${encodeURIComponent(providerId)}`, { method: "POST", body: JSON.stringify({ email }) }).then(link);
  }
  async revoke(providerId: string, invitationId: string): Promise<void> {
    if (!PROVIDER_ID.test(providerId) || !UUID.test(invitationId)) throw new Error("Invalid invitation");
    const value = await this.call(`/api/experience-guide-links/providers/${encodeURIComponent(providerId)}/${invitationId}/revoke`, { method: "POST", body: "{}" });
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || (value as Record<string, unknown>).state !== "REVOKED") throw new Error("Invalid NIHO response");
  }
}

export async function loadHostGuideLinkContext(): Promise<{ ok: true; value: { session: NihoHostSession; client: HostArticleLinkClient } } | { ok: false; response: NextResponse }> {
  if (!config.hostConsoleEnabled || !config.hostArticleLinksEnabled) return { ok: false, response: noStoreJson({ error: "not_found" }, 404) };
  let session: NihoHostSession | null;
  // NIHO's API with the host's NIHO token: an Experience host account reads as signed out (its flag is refused with them).
  try { const current = await readHostSession(); session = current?.kind === "experience" ? null : current; } catch { return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) }; }
  if (!session) return { ok: false, response: noStoreJson({ error: "signed_out" }, 401) };
  if (!accessTokenUsable(session, Date.now())) return { ok: false, response: noStoreJson({ error: "refresh_required" }, 401) };
  return { ok: true, value: { session, client: new HostArticleLinkClient(session) } };
}

export function hostArticleLinkFailure(error: unknown): NextResponse {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  const response = noStoreJson({ error: status === 401 ? "signed_out" : status === 403 ? "forbidden" : status === 404 ? "not_found" : "unavailable" }, status === 401 ? 401 : status === 403 ? 403 : status === 404 ? 404 : 503);
  if (status === 401) clearSessionCookie(response);
  return response;
}
