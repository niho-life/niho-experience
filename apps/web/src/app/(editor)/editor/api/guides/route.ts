import { randomUUID } from "node:crypto";
import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
  readGuideApiJson,
} from "@/lib/editor/guide-api-server";
import { parseGuideCreateBody, privateGuideArticle } from "@/lib/editor/guide-api";

export async function GET() {
  const context = await loadGuideApiContext();
  if (!context.ok) return context.response;
  try {
    const guides = await context.value.repository.listArticles(context.value.actor);
    return guideApiJson({ guides: guides.map(privateGuideArticle) });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function POST(request: Request) {
  const context = await loadGuideApiContext();
  if (!context.ok) return context.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  const raw = await readGuideApiJson(request);
  if (!raw.ok) return guideApiJson({ error: "invalid_input" }, 400);
  const input = parseGuideCreateBody(raw.value);
  if (!input) return guideApiJson({ error: "invalid_input" }, 400);
  try {
    const article = await context.value.repository.createArticle(context.value.actor, { id: randomUUID(), ...input });
    return guideApiJson({ id: article.id, revision: article.revision }, 201);
  } catch (error) {
    return guideApiError(error);
  }
}
