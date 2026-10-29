import { config } from "@/lib/config";
import { guideCoverStorage } from "@/lib/editor/guide-cover-storage";
import { guideRepository } from "@/lib/experience/store-server";

type Context = { params: Promise<{ assetId: string }> };

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_MEDIA_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
} as const;

function publicMediaError(status: 404 | 503) {
  return Response.json(
    { error: status === 404 ? "not_found" : "media_storage_unavailable" },
    { status, headers: PUBLIC_MEDIA_HEADERS },
  );
}

/** Anonymous JPEG relay; every request re-checks the current publication and current asset rights. */
export async function GET(_request?: Request, context?: Context) {
  if (config.guidePublicSource !== "database") return publicMediaError(404);
  const assetId = context ? (await context.params).assetId : "";
  if (!UUID_V4.test(assetId)) return publicMediaError(404);
  try {
    const repository = guideRepository();
    const storage = guideCoverStorage();
    if (repository === null || storage === null) return publicMediaError(503);
    const asset = await repository.getPublicMediaAsset(assetId);
    if (asset === null) return publicMediaError(404);
    const bytes = await storage.read(asset.objectKey);
    if (asset.byteSize === undefined || bytes.byteLength !== asset.byteSize) return publicMediaError(503);
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        ...PUBLIC_MEDIA_HEADERS,
        "content-type": "image/jpeg",
        "content-length": String(bytes.byteLength),
      },
    });
  } catch {
    return publicMediaError(503);
  }
}
