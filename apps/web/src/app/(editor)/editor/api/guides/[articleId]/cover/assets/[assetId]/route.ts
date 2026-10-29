import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
  readGuideApiJson,
} from "@/lib/editor/guide-api-server";
import { privateGuideArticle } from "@/lib/editor/guide-api";
import { guideCoverStorage } from "@/lib/editor/guide-cover-storage";

type GuideCoverAssetRouteContext = { params: Promise<{ articleId: string; assetId: string }> };

export async function GET(request: Request, context: GuideCoverAssetRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const storage = guideCoverStorage();
  if (!storage) return guideApiJson({ error: "media_storage_unavailable" }, 503);
  const { articleId, assetId } = await context.params;
  try {
    const asset = await loaded.value.repository.getReadyMediaAsset(loaded.value.actor, articleId, assetId);
    const bytes = await storage.read(asset.objectKey);
    if (asset.byteSize === undefined || bytes.byteLength !== asset.byteSize) {
      return guideApiJson({ error: "unavailable" }, 503);
    }
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

export async function DELETE(request: Request, context: GuideCoverAssetRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const parsed = await readGuideApiJson(request);
  if (!parsed.ok) return guideApiJson({ error: "invalid_input" }, 400);
  const input = parsed.value;
  if (
    typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).length !== 1 || !("expectedRevision" in input)
    || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1
  ) return guideApiJson({ error: "invalid_input" }, 400);
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
