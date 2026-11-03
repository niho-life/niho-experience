/** No retired editor session or upstream connection is mutated. */
export function POST(): Response {
  return Response.json({ error: "gone" }, { status: 410, headers: { "cache-control": "private, no-store" } });
}
