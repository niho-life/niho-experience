import { config } from "@/lib/config";
import { parseGuideAppCardCursor, readGuideAppCards } from "@/lib/editor-publication/app-cards";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } as const;
const empty = () => Response.json({ version: 1, items: [], nextCursor: null }, { headers: HEADERS });
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });

export async function GET(request: Request): Promise<Response> {
  if (!config.guideAppCardsEnabled) return empty();
  if (
    config.guidePublicSource !== "editor"
    || !config.guideEditorApiBaseUrl
    || config.guideEditorApiHandle !== "exp"
    || !config.guideEditorApiToken
    || !config.guideEditorAssetOrigins.length
  ) return unavailable();
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => key !== "cursor") || query.getAll("cursor").length > 1) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: HEADERS });
  }
  const cursor = query.get("cursor");
  if (cursor !== null && parseGuideAppCardCursor(cursor) === null) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: HEADERS });
  }
  try {
    const page = await readGuideAppCards({
      baseUrl: config.guideEditorApiBaseUrl,
      handle: config.guideEditorApiHandle,
      token: config.guideEditorApiToken,
      assetOrigins: config.guideEditorAssetOrigins,
      siteOrigin: config.siteUrl,
    }, cursor);
    return Response.json(page, { headers: HEADERS });
  } catch {
    return unavailable();
  }
}
