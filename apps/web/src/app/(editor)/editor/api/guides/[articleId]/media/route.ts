import { randomUUID } from "node:crypto";
import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
} from "@/lib/editor/guide-api-server";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/editor/guide-cover-image";
import { guideCoverStorage } from "@/lib/editor/guide-cover-storage";

type GuideMediaRouteContext = { params: Promise<{ articleId: string }> };

export async function GET(request: Request, context: GuideMediaRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  try {
    return guideApiJson({ assets: await loaded.value.repository.listReadyMediaAssets(loaded.value.actor, articleId) });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function POST(request: Request, context: GuideMediaRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return guideApiJson({ error: "unsupported_format" }, 415);
  const storage = guideCoverStorage();
  if (!storage) return guideApiJson({ error: "media_storage_unavailable" }, 503);

  const { articleId } = await context.params;
  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try {
    processed = await processGuideCoverImage(await readGuideCoverInput(request));
  } catch (error) {
    if (error instanceof GuideCoverImageError) {
      const status = error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400;
      return guideApiJson({ error: error.code }, status);
    }
    return guideApiJson({ error: "invalid_image" }, 400);
  }

  const assetId = randomUUID();
  const objectKey = `guide-media/${assetId}.jpg`;
  let created = false;
  try {
    await loaded.value.repository.createMediaAsset(loaded.value.actor, articleId, { id: assetId, objectKey });
    created = true;
    await storage.write(objectKey, processed.bytes);
    const asset = await loaded.value.repository.markMediaAssetReady(
      loaded.value.actor,
      articleId,
      assetId,
      { width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength },
    );
    return guideApiJson({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
  } catch (error) {
    if (created) {
      try { await storage.remove(objectKey); } catch { /* Keep storage detail private; operations can reconcile the orphan. */ }
      try { await loaded.value.repository.revokeMediaAsset(loaded.value.actor, articleId, assetId); } catch { /* Preserve the original failure. */ }
    }
    return guideApiError(error);
  }
}
