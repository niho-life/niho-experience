import {
  createGuideIdempotently,
  experienceSlugFromUrl,
  loadWriteContext,
  parseWriteCreate,
  privateGuideArticle,
  readWriteJson,
  writeApiError,
  writeJson,
  writeMutationAllowed,
} from "@/lib/write/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try {
    const guides = await loaded.value.repository.listArticles(loaded.value.actorId);
    return writeJson({ guides: guides.map(privateGuideArticle) });
  } catch (error) { return writeApiError(error); }
}

export async function POST(request: Request) {
  if (!writeMutationAllowed(request)) return writeJson({ error: "cross_site_request" }, 403);
  const experience = experienceSlugFromUrl(request);
  if (experience === false) return writeJson({ error: "invalid_input" }, 400);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const raw = await readWriteJson(request);
  if (!raw.ok) return raw.response;
  const input = parseWriteCreate(raw.value);
  if (!input) return writeJson({ error: "invalid_input" }, 400);
  if (!loaded.value.office && !loaded.value.ownerProviderIds.includes(input.providerId)) return writeJson({ error: "forbidden" }, 403);
  try {
    const result = await createGuideIdempotently(loaded.value, input, experience);
    return writeJson({
      guide: privateGuideArticle(result.article),
      created: result.created,
      experienceLinked: result.experienceLinked,
    }, result.created ? 201 : 200);
  } catch (error) { return writeApiError(error); }
}
