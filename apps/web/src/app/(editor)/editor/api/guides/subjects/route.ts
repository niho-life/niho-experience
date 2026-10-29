import { guideApiError, guideApiJson, loadGuideApiContext } from "@/lib/editor/guide-api-server";

export async function GET() {
  const context = await loadGuideApiContext();
  if (!context.ok) return context.response;
  try {
    return guideApiJson({ subjects: await context.value.repository.listWritableSubjects(context.value.actor.nihoUserId) });
  } catch (error) {
    return guideApiError(error);
  }
}
