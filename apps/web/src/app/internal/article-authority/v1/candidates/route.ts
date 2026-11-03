import { StoreValidationError } from "@niho-experience/experience-store";
import { articleAuthorityFailure, articleAuthorityJson, candidateItems, exactFields, loadArticleAuthority, readArticleAuthorityBody, writerId } from "@/lib/article-authority/server";

const CURSOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const loaded = await loadArticleAuthority(request);
  if (!loaded.ok) return loaded.response;
  try {
    const body = await readArticleAuthorityBody(request);
    exactFields(body, ["writerNihoUserId"], ["query", "cursor"]);
    if (body.query !== undefined && (typeof body.query !== "string" || body.query.length > 100)) throw new StoreValidationError("query is invalid.");
    if (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 160 || !CURSOR.test(body.cursor))) throw new StoreValidationError("cursor is invalid.");
    return articleAuthorityJson(await candidateItems({ writerNihoUserId: writerId(body.writerNihoUserId), ...(body.query === undefined ? {} : { query: body.query as string }), ...(body.cursor === undefined ? {} : { cursor: body.cursor as string }) }, loaded.dependencies));
  } catch (error) { return articleAuthorityFailure(error); }
}
