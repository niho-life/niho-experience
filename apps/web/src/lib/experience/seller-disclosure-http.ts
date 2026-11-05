import "server-only";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreValidationError,
  type SellerDisclosureInput,
} from "@niho-experience/experience-store";
import { noStoreJson } from "@/lib/host/server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { publicationHostBoundary, publicationHostMutationAllowed } from "./publication-host-boundary";
import { providerSellerDisclosureRepository } from "./store-server";

export const SELLER_DISCLOSURE_CONSENT_VERSION = "seller-public-disclosure-v1";
const BODY_LIMIT = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type JsonObject = Record<string, unknown>;

const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

async function bodyOf(request: Request): Promise<JsonObject | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return error("INVALID_INPUT", 400);
  try {
    const value: unknown = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    return isObject(value) ? value : error("INVALID_INPUT", 400);
  } catch (caught) {
    return error("INVALID_INPUT", caught instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

function disclosureOf(value: unknown): SellerDisclosureInput | null {
  if (!isObject(value) || (value.method !== "NATIVE" && value.method !== "EXTERNAL")) return null;
  const nativeKeys = ["method", "sellerKind", "sellerDisplayName", "representativeName", "publicAddress", "publicPhone", "publicEmail", "consentVersion", "accepted"];
  const externalKeys = ["method", "sellerKind", "sellerDisplayName", "externalUrl", "consentVersion", "accepted"];
  if (!exactKeys(value, value.method === "NATIVE" ? nativeKeys : externalKeys)) return null;
  if ((value.sellerKind !== "PERSON" && value.sellerKind !== "BUSINESS") || typeof value.sellerDisplayName !== "string"
    || value.consentVersion !== SELLER_DISCLOSURE_CONSENT_VERSION || value.accepted !== true) return null;
  if (value.method === "EXTERNAL") return typeof value.externalUrl === "string" ? value as SellerDisclosureInput : null;
  return (value.representativeName === null || typeof value.representativeName === "string")
    && typeof value.publicAddress === "string" && typeof value.publicPhone === "string" && typeof value.publicEmail === "string"
    ? value as SellerDisclosureInput : null;
}

function storeError(caught: unknown): Response {
  if (caught instanceof StoreAccessDeniedError) return error("FORBIDDEN", 403);
  if (caught instanceof StoreConflictError) return error("VERSION_CONFLICT", 409);
  if (caught instanceof StoreValidationError) return error("INVALID_INPUT", 422);
  return error("UNAVAILABLE", 503);
}

async function prepared(operation: "READ" | "OWNER") {
  const boundary = await publicationHostBoundary(operation);
  if (!boundary.ok) return boundary;
  const repository = providerSellerDisclosureRepository();
  return repository ? { ok: true as const, actor: boundary.value.actor, repository } : { ok: false as const, response: error("UNAVAILABLE", 503) };
}

export async function getSellerDisclosure(request: Request): Promise<Response> {
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const context = await prepared("READ");
  if (!context.ok) return context.response;
  try {
    return noStoreJson({ seller: await context.repository.getForOwner(context.actor), consentVersion: SELLER_DISCLOSURE_CONSENT_VERSION });
  } catch (caught) { return storeError(caught); }
}

export async function putSellerDisclosure(request: Request): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return error("FORBIDDEN", 403);
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["commandId", "expectedVersion", "disclosure"])) return error("INVALID_INPUT", 400);
  if (typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)) return error("INVALID_INPUT", 400);
  if (body.expectedVersion !== null && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) return error("INVALID_INPUT", 400);
  const disclosure = disclosureOf(body.disclosure);
  if (!disclosure) return error("INVALID_INPUT", 400);
  const context = await prepared("OWNER");
  if (!context.ok) return context.response;
  try {
    const saved = await context.repository.save(context.actor, { commandId: body.commandId, expectedVersion: body.expectedVersion as number | null, disclosure });
    return noStoreJson({ disclosure: saved });
  } catch (caught) { return storeError(caught); }
}

export async function deleteSellerDisclosure(request: Request): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return error("FORBIDDEN", 403);
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["commandId", "expectedVersion"])) return error("INVALID_INPUT", 400);
  if (typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)) return error("INVALID_INPUT", 400);
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) return error("INVALID_INPUT", 400);
  const context = await prepared("OWNER");
  if (!context.ok) return context.response;
  try {
    const withdrawn = await context.repository.withdraw(context.actor, { commandId: body.commandId, expectedVersion: Number(body.expectedVersion) });
    return noStoreJson({ disclosure: withdrawn });
  } catch (caught) { return storeError(caught); }
}
