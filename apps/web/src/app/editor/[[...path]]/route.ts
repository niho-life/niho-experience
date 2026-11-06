/*
 * The retired Experience article writer (#251, ADR 0002): articles are written on editor.niho.life, and /write sends a
 * visitor there. This one handler keeps the answers the old routes gave, without the code behind them:
 *  - /editor/api/** and /editor/auth/** answer 410 for every method, before any body is read, any OAuth code or state is
 *    forwarded, or a session or the database is touched (so an old client cannot cause a side effect);
 *  - every other page path sends a reader to /write.
 * It deletes no saved draft: the guide tables stay for audit and rollback (docs/adr/0002-guide-content.md).
 */
const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

type Context = { readonly params: Promise<{ readonly path?: readonly string[] }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { path = [] } = await context.params;
  if (path[0] === "api" || path[0] === "auth") return Response.json({ error: "gone" }, { status: 410, headers: HEADERS });
  if (request.method === "GET" || request.method === "HEAD") return new Response(null, { status: 307, headers: { ...HEADERS, location: "/write" } });
  return Response.json({ error: "gone" }, { status: 410, headers: HEADERS });
}

export { handle as DELETE, handle as GET, handle as HEAD, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT };
