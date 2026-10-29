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
import { guideRepository } from "@/lib/experience/store-server";
import {
  clearEditorSessionCookie,
  editorMutationAllowed,
  isEditorConsole,
  loadEditorSession,
} from "./server";

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
  let load: Awaited<ReturnType<typeof loadEditorSession>>;
  try {
    load = await loadEditorSession();
  } catch {
    return { ok: false, response: guideApiJson({ error: "unavailable" }, 503) };
  }
  if (!isEditorConsole()) return { ok: false, response: guideApiJson({ error: "not_found" }, 404) };
  if (load.status === "error") return { ok: false, response: guideApiJson({ error: "unavailable" }, 503) };
  if (load.status !== "ok") {
    const response = guideApiJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
    if (load.status === "rejected") clearEditorSessionCookie(response);
    return { ok: false, response };
  }
  const repository = guideRepository();
  if (!repository) return { ok: false, response: guideApiJson({ error: "unavailable" }, 503) };
  return {
    ok: true,
    value: {
      actor: { nihoUserId: load.session.actorId },
      repository,
    },
  };
}

export function guideApiError(error: unknown): NextResponse {
  if (error instanceof StoreValidationError) return guideApiJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreConflictError) return guideApiJson({ error: "conflict" }, 409);
  if (error instanceof StoreAccessDeniedError || error instanceof StoreNotFoundError) {
    return guideApiJson({ error: "not_found" }, 404);
  }
  return guideApiJson({ error: "unavailable" }, 503);
}
