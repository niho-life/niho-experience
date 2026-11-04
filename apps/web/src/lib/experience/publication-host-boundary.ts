import "server-only";
import { GoogleAuth } from "google-auth-library";
import type { HostActor } from "@niho-experience/experience-store";
import type { ProviderPublicationReadinessInput } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { clearSessionCookie, loadHostProviders, noStoreJson, nihoApiFetch, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
import type { HostProvider } from "@/lib/host/providers";

type Operation = "READ" | "EDIT" | "OWNER";
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);
const NIHO_USER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONNECT_ACCOUNT_ID = /^[A-Za-z0-9_:-]{1,256}$/;

export interface PublicationHostContext {
  readonly actor: HostActor;
  readonly provider: HostProvider;
  readonly readiness: ProviderPublicationReadinessInput | null;
}

export type PublicationHostBoundaryResult =
  | { readonly ok: true; readonly value: PublicationHostContext }
  | { readonly ok: false; readonly response: Response };

interface ContractIdentity { readonly nihoUserId: string; readonly accountStatus: "ACTIVE" }
interface ContractConnectProjection {
  readonly legacyProviderId: string;
  readonly stripeAccountId: string | null;
  readonly readiness: { readonly ready: boolean; readonly reason: string };
}

const serviceAuth = new GoogleAuth();

async function serviceIdentityToken(): Promise<string> {
  const client = await serviceAuth.getIdTokenClient(config.nihoExperienceHostCommonContractAudience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Service identity unavailable");
  return authorization.slice(7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): ContractIdentity | null {
  if (!isRecord(value)
    || typeof value.nihoUserId !== "string" || !NIHO_USER_ID.test(value.nihoUserId)
    || value.accountStatus !== "ACTIVE") return null;
  return { nihoUserId: value.nihoUserId, accountStatus: "ACTIVE" };
}

function parseConnectProjection(value: unknown, expectedProviderId: string): ContractConnectProjection | null {
  if (!isRecord(value) || value.legacyProviderId !== expectedProviderId
    || (value.stripeAccountId !== null && (typeof value.stripeAccountId !== "string"
      || !CONNECT_ACCOUNT_ID.test(value.stripeAccountId)))
    || !isRecord(value.readiness)
    || typeof value.readiness.ready !== "boolean" || typeof value.readiness.reason !== "string") return null;
  if (value.readiness.ready !== (value.readiness.reason === "READY")) return null;
  return {
    legacyProviderId: expectedProviderId,
    stripeAccountId: value.stripeAccountId as string | null,
    readiness: { ready: value.readiness.ready, reason: value.readiness.reason },
  };
}

async function readContractJson(response: Response): Promise<unknown | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try { return await readBoundedJson(response, 4 * 1024, { fatalUtf8: true }); }
  catch (error) {
    if (error instanceof ResponseBodyTooLarge) return null;
    return null;
  }
}

async function callCommonContract(session: NonNullable<Awaited<ReturnType<typeof readHostSession>>>, path: string): Promise<Response> {
  const serviceToken = await serviceIdentityToken();
  return nihoApiFetch(session)(new URL(path, config.nihoWebOrigin), {
    method: "GET",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "x-niho-experience-service-id-token": serviceToken,
      accept: "application/json",
    },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function identityForSession(session: NonNullable<Awaited<ReturnType<typeof readHostSession>>>): Promise<ContractIdentity | Response> {
  let response: Response;
  try { response = await callCommonContract(session, "/api/experience-host/identity"); }
  catch { return error("READINESS_UNAVAILABLE", 502); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      const rejected = error("SESSION_ENDED", 401);
      clearSessionCookie(rejected);
      return rejected;
    }
    if (response.status === 403) return error("FORBIDDEN", 403);
    return error("READINESS_UNAVAILABLE", 502);
  }
  const identity = parseIdentity(await readContractJson(response));
  return identity ?? error("READINESS_UNAVAILABLE", 502);
}

async function connectProjection(
  session: NonNullable<Awaited<ReturnType<typeof readHostSession>>>,
  providerId: string,
): Promise<ContractConnectProjection | Response> {
  let response: Response;
  try { response = await callCommonContract(session, `/api/experience-host/legacy-providers/${encodeURIComponent(providerId)}/connect-account`); }
  catch { return error("READINESS_UNAVAILABLE", 502); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      const rejected = error("SESSION_ENDED", 401);
      clearSessionCookie(rejected);
      return rejected;
    }
    if (response.status === 403 || response.status === 404) return error("FORBIDDEN", 403);
    return error("READINESS_UNAVAILABLE", 502);
  }
  const projection = parseConnectProjection(await readContractJson(response), providerId);
  return projection ?? error("READINESS_UNAVAILABLE", 502);
}

/** Build a mutation-capable actor only from the active NIHO app-connect session and the common contract. */
export async function publicationHostBoundary(operation: Operation): Promise<PublicationHostBoundaryResult> {
  if (!config.experienceHostPublicationApiEnabled) return { ok: false, response: error("NOT_FOUND", 404) };
  const session = await readHostSession();
  if (!session) return { ok: false, response: error("SESSION_ENDED", 401) };
  if (!accessTokenUsable(session, Date.now())) return { ok: false, response: error("SESSION_REFRESH_REQUIRED", 401) };

  const identity = await identityForSession(session);
  if (identity instanceof Response) return { ok: false, response: identity };
  const providers = await loadHostProviders();
  if (providers.status === "signed-out" || providers.status === "rejected") {
    const rejected = error("SESSION_ENDED", 401);
    clearSessionCookie(rejected);
    return { ok: false, response: rejected };
  }
  if (providers.status === "refresh") return { ok: false, response: error("SESSION_REFRESH_REQUIRED", 401) };
  if (providers.status !== "ok") return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  const owned = providers.providers.filter((provider) => provider.memberRole === "OWNER");
  if (owned.length === 0) return { ok: false, response: error("FORBIDDEN", 403) };
  // A seller is the signed-in person. Multiple distinct NIHO seller profiles need an explicit NIHO-side
  // identity resolution; the browser never gets to pick which person's Connect account receives funds.
  if (owned.length !== 1) return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
  const provider = owned[0]!;
  if (operation === "OWNER" && provider.memberRole !== "OWNER") return { ok: false, response: error("FORBIDDEN", 403) };

  const connect = await connectProjection(session, provider.id);
  if (connect instanceof Response) return { ok: false, response: connect };
  const readiness = connect.stripeAccountId === null ? null : {
    accountUsable: identity.accountStatus === "ACTIVE",
    connectReady: connect.readiness.ready,
    sellerDisplayReady: provider.displayName.trim().length > 0,
    sellerNihoAccountRef: identity.nihoUserId,
    stripeConnectAccountRef: connect.stripeAccountId,
    sellerDisplayName: provider.displayName.trim(),
    requiredConsentVersion: config.experiencePublicationConsentVersion,
    observedAtUtc: new Date().toISOString(),
    validUntilUtc: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  } satisfies ProviderPublicationReadinessInput;
  const actor: HostActor = { providerId: provider.id, nihoUserId: identity.nihoUserId };
  return { ok: true, value: { actor, provider, readiness } };
}

export function publicationHostMutationAllowed(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const expected = new URL(config.siteUrl).origin;
  return request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") === "same-origin";
}
