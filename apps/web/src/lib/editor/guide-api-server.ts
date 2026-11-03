import "server-only";
import { NextResponse } from "next/server";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type GuideActor,
  type GuideRepository,
} from "@niho-experience/experience-store";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { editorMutationAllowed } from "./server";

export const GUIDE_API_MAX_BODY_BYTES = 1024 * 1024;

const GUIDE_API_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export function guideApiJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: GUIDE_API_HEADERS });
}

export async function readGuideApiJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (new URL(request.url).search) return { ok: false };
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false };
  try {
    return { ok: true, value: await readBoundedJson(request, GUIDE_API_MAX_BODY_BYTES, { fatalUtf8: true }) };
  } catch {
    return { ok: false };
  }
}

export function guideApiMutationAllowed(request: Request): boolean {
  return editorMutationAllowed(request);
}

export type GuideApiContext = {
  readonly actor: GuideActor;
  readonly repository: GuideRepository;
};

export async function loadGuideApiContext(): Promise<
  | { ok: true; value: GuideApiContext }
  | { ok: false; response: NextResponse }
> {
  // The legacy Experience writer is permanently withdrawn before auth, database
  // access, or body parsing, so old clients cannot cause side effects.
  return { ok: false, response: guideApiJson({ error: "gone" }, 410) };
}

export function guideApiError(error: unknown): NextResponse {
  if (error instanceof StoreValidationError) return guideApiJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreConflictError) return guideApiJson({ error: "conflict" }, 409);
  if (error instanceof StoreAccessDeniedError || error instanceof StoreNotFoundError) {
    return guideApiJson({ error: "not_found" }, 404);
  }
  return guideApiJson({ error: "unavailable" }, 503);
}
