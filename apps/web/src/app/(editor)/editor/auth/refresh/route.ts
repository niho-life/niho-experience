/** The retired editor cannot refresh or recreate a session. */
export function POST(): Response {
  return Response.json({ error: "gone" }, { status: 410, headers: { "cache-control": "private, no-store" } });
}
