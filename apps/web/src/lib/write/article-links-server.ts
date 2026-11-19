import "server-only";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { hostAccountIdentities } from "@/lib/experience/store-server";
import { parseHostArticleLink, type HostArticleLink } from "@/lib/host/guide-link-api-server";
import { readHostSession } from "@/lib/host/server";
import { readBoundedJson } from "@/lib/read-bounded-json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auth = new GoogleAuth();

async function serviceToken(): Promise<string> {
  const client = await auth.getIdTokenClient(config.nihoArticleLinksAudience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Service identity unavailable");
  return authorization.slice(7);
}

export class WriterArticleLinkClient {
  constructor(private readonly writerNihoUserId: string, private readonly fetchImpl: typeof fetch = fetch, private readonly token = serviceToken) {}
  private async call(path: string): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, config.nihoArticleAuthorityOrigin), {
      method: "POST",
      headers: { "x-niho-experience-service-id-token": await this.token(), accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ writerNihoUserId: this.writerNihoUserId }),
      cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      const error = new Error("NIHO writer links unavailable") as Error & { status?: number }; error.status = response.status; throw error;
    }
    return readBoundedJson(response, 64 * 1024, { fatalUtf8: true });
  }
  async list(): Promise<readonly HostArticleLink[]> {
    const value = await this.call("/api/internal/experience-article-links/list");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray((value as { items?: unknown }).items)) throw new Error("Invalid NIHO response");
    return (value as { items: unknown[] }).items.map(parseHostArticleLink);
  }
  async decide(invitationId: string, action: "accept" | "decline"): Promise<HostArticleLink> {
    if (!UUID.test(invitationId)) throw new Error("Invalid invitation");
    return parseHostArticleLink(await this.call(`/api/internal/experience-article-links/${invitationId}/${action}`));
  }
}

export async function writerArticleLinkClient(): Promise<WriterArticleLinkClient | null> {
  if (!config.nihoWriterEnabled) return null;
  const session = await readHostSession();
  if (!session || session.kind !== "experience") return null;
  const nihoUserId = await hostAccountIdentities()?.readNihoUserId({ hostAccountId: session.hostAccountId });
  return nihoUserId ? new WriterArticleLinkClient(nihoUserId) : null;
}

export function writerLinkFailure(error: unknown): Response {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  return Response.json({ error: status === 403 ? "forbidden" : "unavailable" }, { status: status === 403 ? 403 : 503, headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
}
