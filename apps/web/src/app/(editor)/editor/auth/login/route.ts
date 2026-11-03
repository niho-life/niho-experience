const gone = () => Response.json({ error: "gone" }, { status: 410, headers: { "cache-control": "private, no-store" } });

/** The retired editor must not start a new OAuth flow. */
export function GET(): Response {
  return gone();
}
