import { loadWriteContext, writeApiError, writeJson } from "@/lib/write/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try { return writeJson({ categories: await loaded.value.repository.listActiveCategories() }); }
  catch (error) { return writeApiError(error); }
}
