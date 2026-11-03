import { articleAuthorityFailure, articleAuthorityJson, exactFields, loadArticleAuthority, providerId, readArticleAuthorityBody, writerId } from "@/lib/article-authority/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const loaded = await loadArticleAuthority(request);
  if (!loaded.ok) return loaded.response;
  try {
    const body = await readArticleAuthorityBody(request);
    exactFields(body, ["providerId", "ownerNihoUserId"]);
    const providerName = await loaded.dependencies.repository.providerNameForOwner(providerId(body.providerId), writerId(body.ownerNihoUserId));
    return providerName === null ? articleAuthorityJson({ error: "not_found" }, 404) : articleAuthorityJson({ version: 1, providerName });
  } catch (error) { return articleAuthorityFailure(error); }
}
