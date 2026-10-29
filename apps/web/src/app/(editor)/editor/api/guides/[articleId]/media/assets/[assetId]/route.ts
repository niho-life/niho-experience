import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
  readGuideApiJson,
} from "@/lib/editor/guide-api-server";
import { guideCoverStorage } from "@/lib/editor/guide-cover-storage";
import { privateGuideArticle } from "@/lib/editor/guide-api";

type GuideMediaAssetRouteContext = { params: Promise<{ articleId: string; assetId: string }> };

export async function GET(request: Request, context: GuideMediaAssetRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const storage = guideCoverStorage();
  if (!storage) return guideApiJson({ error: "media_storage_unavailable" }, 503);
  const { articleId, assetId } = await context.params;
  try {
    const asset = await loaded.value.repository.getReadyMediaAsset(loaded.value.actor, articleId, assetId);
    const bytes = await storage.read(asset.objectKey);
    if (asset.byteSize === undefined || bytes.byteLength !== asset.byteSize) return guideApiJson({ error: "unavailable" }, 503);
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "image/jpeg",
        "content-length": String(bytes.byteLength),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function PUT(request: Request, context: GuideMediaAssetRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  const raw = await readGuideApiJson(request);
  if (!raw.ok || typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) {
    return guideApiJson({ error: "invalid_input" }, 400);
  }
  const input = raw.value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2
    || typeof input.publicCredit !== "string"
    || input.webConfirmed !== true
  ) return guideApiJson({ error: "invalid_input" }, 400);
  const { articleId, assetId } = await context.params;
  try {
    const asset = await loaded.value.repository.confirmMediaAssetWebRights(
      loaded.value.actor,
      articleId,
      assetId,
      input.publicCredit,
    );
    return guideApiJson({ asset });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function DELETE(request: Request, context: GuideMediaAssetRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const raw = await readGuideApiJson(request);
  if (!raw.ok || typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) {
    return guideApiJson({ error: "invalid_input" }, 400);
  }
  const input = raw.value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.expectedRevision)
    || (input.expectedRevision as number) < 1) {
    return guideApiJson({ error: "invalid_input" }, 400);
  }
  const { articleId, assetId } = await context.params;
  try {
    const article = await loaded.value.repository.revokeMediaAsset(
      loaded.value.actor, articleId, assetId, input.expectedRevision as number,
    );
    return guideApiJson({ guide: privateGuideArticle(article) });
  } catch (error) {
    return guideApiError(error);
  }
}
