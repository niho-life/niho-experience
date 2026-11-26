import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError,
  matchMemberProfileTranslation, memberProxyMethod, validateMemberProfileText,
  type MemberProfileRef,
} from "@niho-experience/experience-store";
import { adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/guide-cover-image";
import { nihoIdOrNull } from "@/lib/host/providers";
import { loadHostProvidersFresh, noStoreJson } from "@/lib/host/server";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";
import { anthropicTranslator } from "@/lib/translation/anthropic";
import { memberProfileToEnglish } from "@/lib/translation/prompts";
import { publicationHostMutationAllowed } from "./publication-host-boundary";
import { experiencePublicMediaStorage } from "./public-media-storage";
import { memberProfileRepository } from "./store-server";

const failure = (code: string, status: number) => noStoreJson({ error: { code } }, status);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function storeFailure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return failure("FORBIDDEN", 403);
  if (error instanceof StoreNotFoundError) return failure("NOT_FOUND", 404);
  if (error instanceof StoreConflictError) return failure("VERSION_CONFLICT", 409);
  if (error instanceof StoreValidationError) return failure("INVALID_INPUT", 422);
  return failure("UNAVAILABLE", 503);
}

export async function hostMemberActor(providerId: string, ownerOnly = false): Promise<MemberProfileRef | Response> {
  if (!nihoIdOrNull(providerId)) return failure("INVALID_INPUT", 400);
  if (config.apiMode !== "http" || !config.experienceHostPublicationApiEnabled) return failure("NOT_FOUND", 404);
  const loaded = await loadHostProvidersFresh();
  if (loaded.status !== "ok") return loaded.status === "error" ? failure("UNAVAILABLE", 503) : failure("SESSION_REQUIRED", 401);
  const membership = loaded.providers.find((provider) => provider.id === providerId);
  if (membership?.memberRole !== "OWNER" && (ownerOnly || membership?.memberRole !== "COHOST")) return failure("FORBIDDEN", 403);
  return { providerId, memberId: loaded.nihoUserId };
}

async function adminMemberActor(ref: MemberProfileRef): Promise<string | Response> {
  if (!isAdminHttp() || !config.experiencePublicationsEnabled) return failure("NOT_FOUND", 404);
  if (!nihoIdOrNull(ref.providerId) || !nihoIdOrNull(ref.memberId)) return failure("INVALID_INPUT", 400);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return loaded.status === "error" ? failure("UNAVAILABLE", 503) : failure("SESSION_REQUIRED", 401);
  return loaded.actor.id;
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return failure("INVALID_INPUT", 415);
  try {
    const value: unknown = await readBoundedJson(request, 32 * 1024, { fatalUtf8: true });
    return isRecord(value) ? value : failure("INVALID_INPUT", 400);
  } catch (caught) {
    return failure("INVALID_INPUT", caught instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

type Repository = NonNullable<ReturnType<typeof memberProfileRepository>>;

async function profileRequest(request: Request, repository: Repository, ref: MemberProfileRef, adminId?: string): Promise<Response> {
  if (new URL(request.url).search) return failure("INVALID_INPUT", 400);
  try {
    if (request.method === "GET") return noStoreJson(adminId === undefined ? await repository.get(ref) : await repository.getAsAdmin(ref));
    const body = await bodyOf(request);
    if (body instanceof Response) return body;
    if (request.method === "PUT") {
      const { name, ja, en, photo, expectedVersion } = body;
      if (photo === undefined || en === undefined) return failure("INVALID_INPUT", 400);
      return noStoreJson(await repository.save(ref, { name, ja, en, photo, expectedVersion }, adminId));
    }
    if (body.action === "translation" && adminId === undefined) {
      const ja = validateMemberProfileText(body.ja, "ja");
      if (!ja.intro) return failure("INVALID_INPUT", 422);
      await repository.get(ref);
      const translator = anthropicTranslator({ timeoutMs: 45_000 });
      if (!translator) return failure("TRANSLATION_UNAVAILABLE", 503);
      const result = await translator(memberProfileToEnglish(ja), { maxLength: 4000 });
      if (!result.ok) return failure("TRANSLATION_UNAVAILABLE", 503);
      try {
        const en = validateMemberProfileText(JSON.parse(result.text), "en");
        matchMemberProfileTranslation(ja, en);
        return noStoreJson({ en });
      } catch { return failure("TRANSLATION_UNAVAILABLE", 503); }
    }
    if (body.action === "proxyPermission") {
      if (typeof body.granted !== "boolean") return failure("INVALID_INPUT", 400);
      const admin = adminId === undefined ? undefined : { id: adminId, method: memberProxyMethod(body.method) };
      return noStoreJson(await repository.setProxyPermission(ref, body.granted, admin));
    }
    if (body.action === "recordConsent" && adminId !== undefined && body.profileConsent === true) {
      return noStoreJson(await repository.recordConsent(ref, body.expectedVersion, adminId, memberProxyMethod(body.method), body.photoConsent));
    }
    if (body.action === "publish") {
      const acceptance = adminId === undefined ? body.profileConsent === true && body.photoConsent === true : body.verified === true;
      return noStoreJson(await repository.publish(ref, body.expectedVersion, acceptance, adminId));
    }
    if (body.action === "withdraw" && adminId === undefined && typeof body.revokePhoto === "boolean") {
      return noStoreJson(await repository.withdraw(ref, body.publicationId, body.revokePhoto));
    }
    return failure("INVALID_INPUT", 400);
  } catch (error) { return storeFailure(error); }
}

async function photoRequest(request: Request, repository: Repository, ref: MemberProfileRef, adminId?: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const storage = experiencePublicMediaStorage();
  if (!storage) return failure("UNAVAILABLE", 503);
  try {
    if (request.method === "GET") {
      if (query.size !== 1 || !query.has("assetId")) return failure("INVALID_INPUT", 400);
      const asset = await repository.getPhoto(ref, query.get("assetId")!, adminId);
      const bytes = await storage.read(asset.objectKey);
      if (bytes.byteLength !== asset.byteSize) return failure("UNAVAILABLE", 503);
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: {
          "cache-control": "private, no-store", "content-type": "image/jpeg", "content-length": String(bytes.byteLength),
          "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex",
        },
      });
    }
    if (query.size) return failure("INVALID_INPUT", 400);
    if (request.headers.get("x-experience-photo-rights-confirmed") !== "true") return failure("PHOTO_RIGHTS_REQUIRED", 422);
    const type = request.headers.get("content-type")?.split(";", 1)[0];
    if (type !== "image/jpeg" && type !== "image/png") return failure("UNSUPPORTED_FORMAT", 415);
    const saved = adminId === undefined ? await repository.get(ref) : await repository.getAsAdmin(ref);
    if (adminId !== undefined && !saved.proxyPermission) return failure("FORBIDDEN", 403);
    const version = Number(request.headers.get("x-experience-profile-version"));
    if (!saved.draft || saved.draft.version !== version) return failure("VERSION_CONFLICT", 409);
    const original = await readGuideCoverInput(request);
    const processed = await processGuideCoverImage(original);
    const id = randomUUID();
    const objectKey = `experience-provider-media/${id}.jpg`;
    await storage.write(objectKey, processed.bytes);
    try {
      return noStoreJson(await repository.addPhoto(ref, version, `${saved.draft.name}の写真`, {
        id, objectKey, sourceRefHash: createHash("sha256").update(original).digest("hex"),
        width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength,
      }, adminId), 201);
    } catch (error) {
      await storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof GuideCoverImageError) return failure(error.code.toUpperCase(), error.code === "payload_too_large" ? 413 : 422);
    return storeFailure(error);
  }
}

export async function hostMemberProfileRequest(request: Request, providerId: string, photo = false): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return failure("FORBIDDEN", 403);
  const ref = await hostMemberActor(providerId);
  if (ref instanceof Response) return ref;
  const repository = memberProfileRepository();
  if (!repository) return failure("UNAVAILABLE", 503);
  return photo ? photoRequest(request, repository, ref) : profileRequest(request, repository, ref);
}

export async function adminMemberProfileRequest(request: Request, ref: MemberProfileRef, photo = false): Promise<Response> {
  if (request.method !== "GET" && !adminMutationAllowed(request)) return failure("FORBIDDEN", 403);
  const adminId = await adminMemberActor(ref);
  if (adminId instanceof Response) return adminId;
  const repository = memberProfileRepository();
  if (!repository) return failure("UNAVAILABLE", 503);
  return photo ? photoRequest(request, repository, ref, adminId) : profileRequest(request, repository, ref, adminId);
}

export async function productMemberSelectionRequest(request: Request, productId: string): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return failure("FORBIDDEN", 403);
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || !query.has("providerId")) return failure("INVALID_INPUT", 400);
  const owner = await hostMemberActor(query.get("providerId")!, true);
  if (owner instanceof Response) return owner;
  const repository = memberProfileRepository();
  if (!repository) return failure("UNAVAILABLE", 503);
  try {
    if (request.method === "GET") return noStoreJson(await repository.getProductSelection(owner, productId));
    const body = await bodyOf(request);
    if (body instanceof Response) return body;
    return noStoreJson(await repository.saveProductSelection(owner, productId, body.selected, body.expected));
  } catch (error) { return storeFailure(error); }
}
