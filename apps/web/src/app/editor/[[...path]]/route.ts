/* The old /editor path is permanently retired; articles are managed in /write. */
const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

type Context = { readonly params: Promise<{ readonly path?: readonly string[] }> };

async function handle(_request: Request, context: Context): Promise<Response> {
  await context.params;
  return Response.json({ error: "gone" }, { status: 410, headers: HEADERS });
}

export { handle as DELETE, handle as GET, handle as HEAD, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT };
