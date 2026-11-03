/** OAuth code/state values from the retired editor are never forwarded. */
export function GET(): Response {
  return Response.json({ error: "gone" }, { status: 410, headers: { "cache-control": "private, no-store" } });
}
