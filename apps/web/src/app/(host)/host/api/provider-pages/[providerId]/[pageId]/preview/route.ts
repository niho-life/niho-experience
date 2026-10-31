import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson } from "@/lib/host/provider-operations-server";

/* 体験ページのプレビュー (#89): NIHO's public assembly of the saved page, read only. Drafts and paused pages answer too; a page with no active offer is a 404. */
type Context = { params: Promise<{ providerId: string; pageId: string }> };
async function ids(context: Context) { const value = await context.params; return isExperienceProviderOperationPathId(value.providerId) && isExperienceProviderOperationPathId(value.pageId) ? value : null; }
export async function GET(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getExperienceProviderPagePreview(value.providerId, value.pageId);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
