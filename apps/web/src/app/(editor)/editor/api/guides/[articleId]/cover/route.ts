import { randomUUID } from "node:crypto";
import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
} from "@/lib/editor/guide-api-server";
import {
  GuideCoverImageError,
  processGuideCoverImage,
  readGuideCoverInput,
} from "@/lib/editor/guide-cover-image";
import { guideCoverStorage } from "@/lib/editor/guide-cover-storage";

type GuideCoverRouteContext = { params: Promise<{ articleId: string }> };

export async function POST(request: Request, context: GuideCoverRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    return guideApiJson({ error: "unsupported_format" }, 415);
  }
  const storage = guideCoverStorage();
  if (!storage) return guideApiJson({ error: "media_storage_unavailable" }, 503);

  const { articleId } = await context.params;
  let input: Buffer;
  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try {
    input = await readGuideCoverInput(request);
    processed = await processGuideCoverImage(input);
  } catch (error) {
    if (error instanceof GuideCoverImageError) {
      const status = error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400;
      return guideApiJson({ error: error.code }, status);
    }
    return guideApiJson({ error: "invalid_image" }, 400);
  }

  const assetId = randomUUID();
  const objectKey = `guide-covers/${assetId}.jpg`;
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
      // A timed-out write may have completed in GCS. Remove the unpublished object even when write rejected.
      try { await storage.remove(objectKey); } catch { /* A private orphan is safer than exposing storage detail. */ }
      try { await loaded.value.repository.revokeMediaAsset(loaded.value.actor, articleId, assetId); } catch { /* Preserve the original failure. */ }
    }
    return guideApiError(error);
  }
}
