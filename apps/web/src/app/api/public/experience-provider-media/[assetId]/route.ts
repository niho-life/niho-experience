import { config } from "@/lib/config";
import { experiencePublicMediaStorage } from "@/lib/experience/public-media-storage";
import { experiencePublicationRepository } from "@/lib/experience/store-server";

type Context = { params: Promise<{ assetId: string }> };

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
} as const;

function error(status: 404 | 503) {
  return Response.json({ error: status === 404 ? "not_found" : "media_storage_unavailable" }, { status, headers: HEADERS });
}

/** A provider image is returned only while it remains selected and a product by its seller is public. */
export async function GET(_request: Request, context: Context) {
  if (config.apiMode !== "http" || !config.experiencePublicationsEnabled) return error(404);
  const assetId = (await context.params).assetId;
  if (!UUID_V4.test(assetId)) return error(404);
  try {
    const [repository, storage] = [experiencePublicationRepository(), experiencePublicMediaStorage()];
    if (repository === null || storage === null) return error(503);
    const asset = await repository.getPublicProviderMediaAsset(assetId);
    if (asset === null) return error(404);
    const bytes = await storage.read(asset.objectKey);
    if (bytes.byteLength !== asset.byteSize) return error(503);
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: { ...HEADERS, "content-type": "image/jpeg", "content-length": String(bytes.byteLength) },
    });
  } catch {
    return error(503);
  }
}
