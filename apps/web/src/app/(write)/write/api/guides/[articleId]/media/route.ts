import { randomUUID } from "node:crypto";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/guide-cover-image";
import { guideCoverStorage } from "@/lib/guide-cover-storage";
import {
  loadWriteContext,
  validArticleId,
  writeApiError,
  writeJson,
  writeMutationAllowed,
} from "@/lib/write/server";

type Context = { readonly params: Promise<{ readonly articleId: string }> };
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: Context) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try {
    return writeJson({ assets: await loaded.value.repository.listReadyMediaAssets(loaded.value.actorId, articleId) });
  } catch (error) { return writeApiError(error); }
}

export async function POST(request: Request, context: Context) {
  if (!writeMutationAllowed(request)) return writeJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return writeJson({ error: "unsupported_format" }, 415);
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const storage = guideCoverStorage();
  if (!storage) return writeJson({ error: "media_storage_unavailable" }, 503);

  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try {
    processed = await processGuideCoverImage(await readGuideCoverInput(request));
  } catch (error) {
    if (error instanceof GuideCoverImageError) {
      const status = error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400;
      return writeJson({ error: error.code }, status);
    }
    return writeJson({ error: "invalid_image" }, 400);
  }

  const assetId = randomUUID();
  const objectKey = `guide-media/${assetId}.jpg`;
  let registered = false;
  try {
    await loaded.value.repository.createMediaAsset(loaded.value.actorId, articleId, { id: assetId, objectKey });
    registered = true;
    await storage.write(objectKey, processed.bytes);
    const asset = await loaded.value.repository.markMediaAssetReady(loaded.value.actorId, articleId, assetId, {
      width: processed.width,
      height: processed.height,
      byteSize: processed.bytes.byteLength,
    });
    return writeJson({
      asset: {
        id: asset.id,
        width: asset.width,
        height: asset.height,
        webConfirmed: false,
        previewUrl: `/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(asset.id)}`,
      },
    }, 201);
  } catch (error) {
    // The object name is a fresh UUID under the fixed private prefix. Remove
    // only that object, and revoke only the matching UPLOADING row.
    if (registered) await storage.remove(objectKey).catch(() => undefined);
    if (registered) await loaded.value.repository.revokeMediaAsset(loaded.value.actorId, articleId, assetId).catch(() => undefined);
    return writeApiError(error);
  }
}
