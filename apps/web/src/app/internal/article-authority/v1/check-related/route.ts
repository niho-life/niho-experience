import { allowedRelatedSlugs, articleAuthorityFailure, articleAuthorityJson, articleSlugs, exactFields, loadArticleAuthority, readArticleAuthorityBody, writerId } from "@/lib/article-authority/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const loaded = await loadArticleAuthority(request);
  if (!loaded.ok) return loaded.response;
  try {
    const body = await readArticleAuthorityBody(request);
    exactFields(body, ["writerNihoUserId", "slugs"]);
    const allowedSlugs = await allowedRelatedSlugs(writerId(body.writerNihoUserId), articleSlugs(body.slugs), loaded.dependencies);
    return articleAuthorityJson({ version: 1, allowedSlugs });
  } catch (error) { return articleAuthorityFailure(error); }
}
