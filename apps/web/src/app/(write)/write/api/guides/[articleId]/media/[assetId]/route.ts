import { guideCoverStorage } from "@/lib/guide-cover-storage";
import {
  loadWriteContext,
  privateGuideArticle,
  readWriteJson,
  validArticleId,
  writeApiError,
  writeImage,
  writeJson,
  writeMutationAllowed,
} from "@/lib/write/server";

type Context = { readonly params: Promise<{ readonly articleId: string; readonly assetId: string }> };
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validParams(articleId: string, assetId: string): boolean {
  return validArticleId(articleId) && ASSET_ID.test(assetId);
}

export async function GET(request: Request, context: Context) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId, assetId } = await context.params;
  if (!validParams(articleId, assetId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const storage = guideCoverStorage();
  if (!storage) return writeJson({ error: "media_storage_unavailable" }, 503);
  try {
    const asset = await loaded.value.repository.getReadyMediaAsset(loaded.value.actorId, articleId, assetId);
    const bytes = await storage.read(asset.objectKey);
    if (asset.byteSize === undefined || bytes.byteLength !== asset.byteSize) return writeJson({ error: "unavailable" }, 503);
    return writeImage(bytes);
  } catch (error) { return writeApiError(error); }
}

export async function PUT(request: Request, context: Context) {
  if (!writeMutationAllowed(request)) return writeJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId, assetId } = await context.params;
  if (!validParams(articleId, assetId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const raw = await readWriteJson(request);
  if (!raw.ok) return raw.response;
  if (typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) return writeJson({ error: "invalid_input" }, 400);
  const input = raw.value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input.publicCredit !== "string" || input.webConfirmed !== true) {
    return writeJson({ error: "invalid_input" }, 400);
  }
  try {
    const asset = await loaded.value.repository.confirmMediaAssetWebRights(loaded.value.actorId, articleId, assetId, input.publicCredit);
    return writeJson({ asset });
  } catch (error) { return writeApiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  if (!writeMutationAllowed(request)) return writeJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId, assetId } = await context.params;
  if (!validParams(articleId, assetId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const raw = await readWriteJson(request);
  if (!raw.ok) return raw.response;
  if (typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) return writeJson({ error: "invalid_input" }, 400);
  const input = raw.value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) {
    return writeJson({ error: "invalid_input" }, 400);
  }
  try {
    const article = await loaded.value.repository.revokeMediaAsset(loaded.value.actorId, articleId, assetId, input.expectedRevision as number);
    return writeJson({ guide: privateGuideArticle(article) });
  } catch (error) { return writeApiError(error); }
}
